type Mode = "general" | "learning" | "research";
type RequestState = "queued" | "processing" | "completed" | "failed" | "provider_outcome_unknown";
type Sql = DurableObjectStorage["sql"];
type ConversationRow = { conversation_id:string; tenant_id:string; mode:Mode; title:string; created_at:number; updated_at:number; next_sequence:number };
type RequestRow = { request_id:string; sequence:number; state:RequestState; mode:Mode; user_content:string; attachments_json:string|null; response_json:string|null; error_code:string|null; lease_expires_at:number|null; fencing_token:number; provider_call_started_at:number|null; created_at:number; updated_at:number };

const TENANT_RE = /^\d{1,20}$/;
const CONVERSATION_RE = /^[a-f0-9-]{36}$/i;
const REQUEST_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_LEASE_MS = 120_000;
const DEFAULT_LEASE_MS = 60_000;
const MAX_ATTACHMENTS_BYTES = 8 * 1024 * 1024;
const MAX_ANSWER_CHARS = 20_000;
const MAX_STORED_MESSAGES = 20;

function json(data:unknown,status=200):Response {
  return Response.json(data,{status,headers:{"Cache-Control":"no-store"}});
}
function isMode(value:unknown):value is Mode {
  return value==="general"||value==="learning"||value==="research";
}
function safeJson(value:unknown):string {
  try { return JSON.stringify(value); } catch { return ""; }
}
export function companionAlarmBackoffMs(retryCount:number):number {
  const n=Number.isSafeInteger(retryCount)?Math.max(0,Math.min(8,retryCount)):0;
  return Math.min(60_000,1_000*(2**n));
}

export class CompanionConversation {
  private readonly sql:Sql;
  private readonly tenantId:string;
  private readonly conversationId:string;
  private readonly identityValid:boolean;

  constructor(private readonly ctx:DurableObjectState) {
    this.sql=ctx.storage.sql;
    const objectName=(ctx.id as unknown as {name?:string}).name ?? "";
    const match=objectName.match(/^tenant:(\d{1,20}):conversation:([a-f0-9-]{36})$/i);
    this.identityValid=!!match;
    this.tenantId=match?.[1] ?? "";
    this.conversationId=match?.[2] ?? "";
    this.sql.exec(`CREATE TABLE IF NOT EXISTS companion_conversation (
      conversation_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      next_sequence INTEGER NOT NULL DEFAULT 1
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS companion_messages (
      sequence INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      sources_json TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(sequence,ordinal)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS companion_requests (
      request_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE,
      state TEXT NOT NULL,
      mode TEXT NOT NULL,
      user_content TEXT NOT NULL,
      attachments_json TEXT,
      response_json TEXT,
      error_code TEXT,
      lease_expires_at INTEGER,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      provider_call_started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS companion_requests_state_sequence ON companion_requests(state,sequence)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS companion_requests_lease ON companion_requests(state,lease_expires_at)");
  }

  async fetch(request:Request):Promise<Response> {
    const url=new URL(request.url);
    if(!this.identityValid) return json({ok:false,error:"Некорректная идентичность Companion Durable Object."},500);
    if(request.method==="GET" && url.pathname==="/conversation") {
      if(!this.authorized(url.searchParams.get("tenantId"),url.searchParams.get("conversationId")))
        return json({ok:false,error:"Доступ к диалогу запрещён."},403);
      return this.readConversation();
    }
    if(request.method==="GET" && url.pathname==="/status") {
      if(!this.authorized(url.searchParams.get("tenantId"),url.searchParams.get("conversationId")))
        return json({ok:false,error:"Доступ к диалогу запрещён."},403);
      const requestId=url.searchParams.get("requestId") ?? "";
      if(!REQUEST_RE.test(requestId)) return json({ok:false,error:"Некорректный requestId."},400);
      return this.readStatus(requestId);
    }
    if(request.method==="POST") {
      const body=await request.json().catch(()=>null) as Record<string,unknown>|null;
      if(!body) return json({ok:false,error:"Некорректное тело запроса."},400);
      if(!this.authorized(body.tenantId,body.conversationId))
        return json({ok:false,error:"Доступ к диалогу запрещён."},403);
      switch(url.pathname) {
        case "/enqueue": return this.enqueue(body);
        case "/claim": return this.claim(body);
        case "/provider-started": return this.providerStarted(body);
        case "/finalize": return this.finalize(body);
        case "/fail": return this.fail(body);
        case "/internal/recover": return this.recoverEndpoint(body);
        default: return json({ok:false,error:"Маршрут не найден."},404);
      }
    }
    return json({ok:false,error:"Метод не поддерживается."},405);
  }

  async alarm(info?:{retryCount?:number}):Promise<void> {
    try {
      this.recoverExpired(Date.now());
      await this.ctx.storage.delete("companion_alarm_failures");
    } catch {
      let failures=0;
      try {
        failures=Number(await this.ctx.storage.get<number>("companion_alarm_failures") ?? 0)+1;
        await this.ctx.storage.put("companion_alarm_failures",failures);
      } catch {}
      const attempt=Math.max(failures,Number(info?.retryCount ?? 0));
      await this.ctx.storage.setAlarm(Date.now()+companionAlarmBackoffMs(attempt));
    }
  }

  private authorized(tenant:unknown,conversation:unknown):boolean {
    return typeof tenant==="string" && TENANT_RE.test(tenant) && tenant===this.tenantId &&
      typeof conversation==="string" && CONVERSATION_RE.test(conversation) &&
      conversation.toLowerCase()===this.conversationId.toLowerCase();
  }

  private enqueue(body:Record<string,unknown>):Response {
    const requestId=typeof body.requestId==="string"?body.requestId:"";
    const userContent=typeof body.userContent==="string"?body.userContent:"";
    const mode=body.mode;
    const title=typeof body.title==="string"?body.title.slice(0,72):userContent.slice(0,72);
    if(!REQUEST_RE.test(requestId)||!isMode(mode)||(!userContent.trim()&&!Array.isArray(body.attachments))||userContent.length>4_000)
      return json({ok:false,error:"Некорректные параметры сообщения."},400);
    const attachments=Array.isArray(body.attachments)?body.attachments:[];
    if(attachments.length>4) return json({ok:false,error:"Слишком много вложений."},413);
    const attachmentsJson=attachments.length?safeJson(attachments):null;
    if(attachments.length && (!attachmentsJson || new TextEncoder().encode(attachmentsJson).byteLength>MAX_ATTACHMENTS_BYTES))
      return json({ok:false,error:"Размер вложений превышает лимит."},413);
    const now=Date.now();
    const result=this.sqlTransaction(()=>{
      let conversation=this.sql.exec("SELECT conversation_id,tenant_id,mode,title,created_at,updated_at,next_sequence FROM companion_conversation WHERE conversation_id=?",this.conversationId).toArray()[0] as ConversationRow|undefined;
      if(conversation && (conversation.tenant_id!==this.tenantId || conversation.mode!==mode))
        return {status:409 as const,body:{ok:false,error:"Режим диалога нельзя менять, а владелец не совпадает."}};
      if(!conversation) {
        this.sql.exec("INSERT INTO companion_conversation(conversation_id,tenant_id,mode,title,created_at,updated_at,next_sequence) VALUES(?,?,?,?,?,?,1)",
          this.conversationId,this.tenantId,mode,title,now,now);
      }
      const existing=this.sql.exec("SELECT request_id,sequence,state,mode,user_content,attachments_json,response_json,error_code,lease_expires_at,fencing_token,provider_call_started_at,created_at,updated_at FROM companion_requests WHERE request_id=?",requestId).toArray()[0] as RequestRow|undefined;
      if(existing) {
        if(existing.mode!==mode || existing.user_content!==userContent || (existing.attachments_json??null)!==(attachmentsJson??null))
          return {status:409 as const,body:{ok:false,error:"requestId уже использован с другим содержимым."}};
        return {status:200 as const,body:{ok:true,duplicate:true,requestId,state:existing.state,sequence:existing.sequence,response:existing.response_json?JSON.parse(existing.response_json):null}};
      }
      const seqRow=this.sql.exec("SELECT next_sequence FROM companion_conversation WHERE conversation_id=?",this.conversationId).toArray()[0] as {next_sequence:number};
      const sequence=Number(seqRow.next_sequence);
      this.sql.exec("UPDATE companion_conversation SET next_sequence=?,updated_at=? WHERE conversation_id=?",sequence+1,now,this.conversationId);
      this.sql.exec("INSERT INTO companion_requests(request_id,sequence,state,mode,user_content,attachments_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        requestId,sequence,"queued",mode,userContent,attachmentsJson,now,now);
      return {status:202 as const,body:{ok:true,duplicate:false,requestId,state:"queued",sequence}};
    });
    return json(result.body,result.status);
  }

  private claim(body:Record<string,unknown>):Response {
    const requestId=typeof body.requestId==="string"?body.requestId:"";
    const now=Number.isSafeInteger(body.now)?Number(body.now):Date.now();
    const requestedLease=Number(body.leaseMs ?? DEFAULT_LEASE_MS);
    const leaseMs=Number.isSafeInteger(requestedLease)?Math.max(1_000,Math.min(MAX_LEASE_MS,requestedLease)):DEFAULT_LEASE_MS;
    if(!REQUEST_RE.test(requestId)) return json({ok:false,error:"Некорректный requestId."},400);
    const result=this.sqlTransaction(()=>{
      let row=this.getRequest(requestId);
      if(!row) return {status:404 as const,body:{ok:false,error:"Запрос не найден."}};
      if(row.state==="completed") return {status:200 as const,body:{ok:true,state:row.state,duplicate:true,response:row.response_json?JSON.parse(row.response_json):null}};
      if(row.state==="failed"||row.state==="provider_outcome_unknown")
        return {status:409 as const,body:{ok:false,state:row.state,error:row.error_code ?? "Запрос завершён без повторного запуска."}};
      const earlier=this.sql.exec("SELECT request_id,state FROM companion_requests WHERE sequence<? AND state NOT IN ('completed','failed','provider_outcome_unknown') ORDER BY sequence LIMIT 1",row.sequence).toArray()[0] as {request_id:string;state:string}|undefined;
      if(earlier) return {status:202 as const,body:{ok:true,state:"queued",blockedBy:earlier.request_id}};
      if(row.state==="processing" && Number(row.lease_expires_at ?? 0)>now)
        return {status:202 as const,body:{ok:true,state:"processing",requestId,leaseExpiresAt:row.lease_expires_at,fencingToken:row.fencing_token}};
      if(row.state==="processing" && row.provider_call_started_at!==null) {
        this.sql.exec("UPDATE companion_requests SET state='provider_outcome_unknown',error_code='provider_outcome_unknown',lease_expires_at=NULL,updated_at=? WHERE request_id=?",now,requestId);
        return {status:409 as const,body:{ok:false,state:"provider_outcome_unknown",error:"Результат предыдущего запроса к ИИ неизвестен. Автоматический повтор запрещён."}};
      }
      const token=Number(row.fencing_token)+1;
      const expires=now+leaseMs;
      this.sql.exec("UPDATE companion_requests SET state='processing',fencing_token=?,lease_expires_at=?,updated_at=? WHERE request_id=?",token,expires,now,requestId);
      return {status:200 as const,body:{ok:true,state:"claimed",requestId,sequence:row.sequence,fencingToken:token,leaseExpiresAt:expires,userContent:row.user_content,attachments:row.attachments_json?JSON.parse(row.attachments_json):[]}};
    });
    if(result.status===200 && result.body.state==="claimed") void this.ctx.storage.setAlarm(Number(result.body.leaseExpiresAt)).catch(()=>{});
    return json(result.body,result.status);
  }

  private providerStarted(body:Record<string,unknown>):Response {
    const requestId=typeof body.requestId==="string"?body.requestId:"";
    const token=Number(body.fencingToken);
    if(!REQUEST_RE.test(requestId)||!Number.isSafeInteger(token)||token<1) return json({ok:false,error:"Некорректные параметры запуска провайдера."},400);
    const now=Date.now();
    const result=this.sqlTransaction(()=>{
      const row=this.getRequest(requestId);
      if(!row) return {status:404 as const,body:{ok:false,error:"Запрос не найден."}};
      if(row.state==="completed") return {status:200 as const,body:{ok:true,state:"completed",duplicate:true}};
      if(row.state!=="processing"||row.fencing_token!==token)
        return {status:409 as const,body:{ok:false,state:row.state,error:"Исполнитель больше не владеет запросом."}};
      this.sql.exec("UPDATE companion_requests SET provider_call_started_at=COALESCE(provider_call_started_at,?),updated_at=? WHERE request_id=?",now,now,requestId);
      return {status:200 as const,body:{ok:true,state:"processing",providerStarted:true}};
    });
    return json(result.body,result.status);
  }

  private finalize(body:Record<string,unknown>):Response {
    const requestId=typeof body.requestId==="string"?body.requestId:"";
    const token=Number(body.fencingToken);
    const answer=typeof body.answer==="string"?body.answer:"";
    const sources=Array.isArray(body.sources)?body.sources:[];
    if(!REQUEST_RE.test(requestId)||!Number.isSafeInteger(token)||token<1||!answer.trim()||answer.length>MAX_ANSWER_CHARS||sources.length>10)
      return json({ok:false,error:"Некорректный ответ для сохранения."},400);
    for(const item of sources) {
      const source=item as Record<string,unknown>;
      if(!source||typeof source.title!=="string"||typeof source.url!=="string") return json({ok:false,error:"Некорректный источник."},400);
      try { const parsed=new URL(source.url); if(parsed.protocol!=="https:"||parsed.username||parsed.password) return json({ok:false,error:"Некорректный URL источника."},400); }
      catch { return json({ok:false,error:"Некорректный URL источника."},400); }
    }
    const now=Date.now();
    const responsePayload={answer,sources,conversationId:this.conversationId};
    const responseJson=JSON.stringify(responsePayload);
    const result=this.sqlTransaction(()=>{
      const row=this.getRequest(requestId);
      if(!row) return {status:404 as const,body:{ok:false,error:"Запрос не найден."}};
      if(row.state==="completed") {
        const same=row.response_json===responseJson;
        return same
          ? {status:200 as const,body:{ok:true,duplicate:true,state:"completed",response:responsePayload}}
          : {status:409 as const,body:{ok:false,error:"Запрос уже завершён с другим ответом."}};
      }
      if(row.state!=="processing"||row.fencing_token!==token||row.provider_call_started_at===null)
        return {status:409 as const,body:{ok:false,state:row.state,error:"Устаревший исполнитель или провайдер не был запущен."}};
      const conversation=this.sql.exec("SELECT conversation_id FROM companion_conversation WHERE conversation_id=?",this.conversationId).toArray()[0];
      if(!conversation) return {status:404 as const,body:{ok:false,error:"Диалог не найден."}};
      this.sql.exec("INSERT INTO companion_messages(sequence,ordinal,role,content,sources_json,created_at) VALUES(?,?,?,?,?,?)",
        row.sequence,0,"user",row.user_content,null,row.created_at);
      this.sql.exec("INSERT INTO companion_messages(sequence,ordinal,role,content,sources_json,created_at) VALUES(?,?,?,?,?,?)",
        row.sequence,1,"assistant",answer,sources.length?JSON.stringify(sources):null,now);
      const excess=this.sql.exec("SELECT sequence,ordinal FROM companion_messages ORDER BY sequence DESC,ordinal DESC LIMIT -1 OFFSET ?",MAX_STORED_MESSAGES).toArray() as Array<{sequence:number;ordinal:number}>;
      for(const item of excess) this.sql.exec("DELETE FROM companion_messages WHERE sequence=? AND ordinal=?",item.sequence,item.ordinal);
      this.sql.exec("UPDATE companion_requests SET state='completed',response_json=?,error_code=NULL,lease_expires_at=NULL,updated_at=? WHERE request_id=?",
        responseJson,now,requestId);
      this.sql.exec("UPDATE companion_conversation SET updated_at=? WHERE conversation_id=?",now,this.conversationId);
      return {status:200 as const,body:{ok:true,duplicate:false,state:"completed",response:responsePayload}};
    });
    return json(result.body,result.status);
  }

  private fail(body:Record<string,unknown>):Response {
    const requestId=typeof body.requestId==="string"?body.requestId:"";
    const token=Number(body.fencingToken);
    const errorCode=typeof body.errorCode==="string"?body.errorCode.slice(0,80):"provider_failed";
    if(!REQUEST_RE.test(requestId)||!Number.isSafeInteger(token)||token<1) return json({ok:false,error:"Некорректные параметры ошибки."},400);
    const now=Date.now();
    const result=this.sqlTransaction(()=>{
      const row=this.getRequest(requestId);
      if(!row) return {status:404 as const,body:{ok:false,error:"Запрос не найден."}};
      if(row.state==="completed") return {status:409 as const,body:{ok:false,state:row.state,error:"Запрос уже завершён."}};
      if(row.state!=="processing"||row.fencing_token!==token)
        return {status:409 as const,body:{ok:false,state:row.state,error:"Исполнитель больше не владеет запросом."}};
      const unknown=row.provider_call_started_at!==null;
      const state=unknown?"provider_outcome_unknown":"failed";
      this.sql.exec("UPDATE companion_requests SET state=?,error_code=?,lease_expires_at=NULL,updated_at=? WHERE request_id=?",state,errorCode,now,requestId);
      return {status:200 as const,body:{ok:true,state}};
    });
    return json(result.body,result.status);
  }

  private recoverEndpoint(body:Record<string,unknown>):Response {
    const now=Number.isSafeInteger(body.now)?Number(body.now):Date.now();
    const recovered=this.recoverExpired(now);
    return json({ok:true,recovered});
  }

  private recoverExpired(now:number):number {
    return this.sqlTransaction(()=>{
      const expired=this.sql.exec("SELECT request_id,provider_call_started_at FROM companion_requests WHERE state='processing' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?",now).toArray() as Array<{request_id:string;provider_call_started_at:number|null}>;
      for(const row of expired) {
        const state=row.provider_call_started_at===null?"queued":"provider_outcome_unknown";
        const error=state==="queued"?null:"provider_outcome_unknown";
        this.sql.exec("UPDATE companion_requests SET state=?,error_code=?,lease_expires_at=NULL,updated_at=? WHERE request_id=?",state,error,now,row.request_id);
      }
      return expired.length;
    });
  }

  private readStatus(requestId:string):Response {
    const row=this.getRequest(requestId);
    if(!row) return json({ok:false,error:"Запрос не найден."},404);
    return json({ok:true,requestId,state:row.state,sequence:row.sequence,errorCode:row.error_code,response:row.response_json?JSON.parse(row.response_json):null});
  }

  private readConversation():Response {
    const meta=this.sql.exec("SELECT conversation_id,tenant_id,mode,title,created_at,updated_at,next_sequence FROM companion_conversation WHERE conversation_id=?",this.conversationId).toArray()[0] as ConversationRow|undefined;
    if(!meta||meta.tenant_id!==this.tenantId) return json({ok:false,error:"Диалог не найден."},404);
    const messages=this.sql.exec("SELECT sequence,ordinal,role,content,sources_json,created_at FROM companion_messages ORDER BY sequence,ordinal").toArray() as Array<{sequence:number;ordinal:number;role:string;content:string;sources_json:string|null;created_at:number}>;
    return json({ok:true,conversation:{id:meta.conversation_id,title:meta.title,mode:meta.mode,createdAt:new Date(meta.created_at).toISOString(),updatedAt:new Date(meta.updated_at).toISOString(),messages:messages.map(row=>({role:row.role,content:row.content,createdAt:new Date(row.created_at).toISOString(),...(row.sources_json?{sources:JSON.parse(row.sources_json)}:{})}))}});
  }

  private getRequest(requestId:string):RequestRow|undefined {
    return this.sql.exec("SELECT request_id,sequence,state,mode,user_content,attachments_json,response_json,error_code,lease_expires_at,fencing_token,provider_call_started_at,created_at,updated_at FROM companion_requests WHERE request_id=?",requestId).toArray()[0] as RequestRow|undefined;
  }

  private sqlTransaction<T>(fn:()=>T):T {
    return this.ctx.storage.transactionSync(fn);
  }
}
