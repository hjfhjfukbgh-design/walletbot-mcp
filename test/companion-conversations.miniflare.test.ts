import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

type Stub = { fetch(input:RequestInfo|URL,init?:RequestInit):Promise<Response> };
const tenantA="111111111";
const tenantB="222222222";
const conversationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("CompanionConversation SQLite integration",()=>{
  let source="";
  let root="";
  let mf:Miniflare|undefined;
  let sequence=0;

  beforeAll(async()=>{
    root=".mf-companion-conversation-"+Date.now()+"-"+Math.random().toString(36).slice(2);
    const bundle=await build({entryPoints:["src/companion-conversations.ts"],bundle:true,platform:"browser",format:"esm",write:false});
    source=bundle.outputFiles[0].text+"\nexport default { fetch() { return new Response('ok'); } };";
  });
  afterAll(async()=>{await mf?.dispose();});
  beforeEach(async()=>{await mf?.dispose();mf=undefined;sequence++;});

  async function boot():Promise<{stub:(tenant:string,id?:string)=>Stub;dispose:()=>Promise<void>}> {
    mf=new Miniflare({
      workers:[{
        config:{
          name:"companion-conversation-test",
          compatibilityDate:"2025-06-01",
          env:{COMPANION_CONVERSATIONS:{type:"durable-object",worker:"companion-conversation-test",exportName:"CompanionConversation"}},
          exports:{CompanionConversation:{type:"durable-object",storage:"sqlite"}},
          manifest:{mainModule:"conversation.mjs",modules:{"conversation.mjs":{type:"esm",contents:source}}},
        },
      }],
      resourcePersistencePath:root+"-"+sequence,
    });
    const ns=await mf.getDurableObjectNamespace("COMPANION_CONVERSATIONS");
    return {
      stub:(tenant,id=conversationId)=>ns.get(ns.idFromName("tenant:"+tenant+":conversation:"+id)) as unknown as Stub,
      dispose:async()=>{await mf?.dispose();mf=undefined;},
    };
  }

  async function post(stub:Stub,path:string,body:Record<string,unknown>){
    const response=await stub.fetch("https://conversation.test"+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json() as Record<string,any>};
  }
  async function get(stub:Stub,path:string){
    const response=await stub.fetch("https://conversation.test"+path);
    return {status:response.status,body:await response.json() as Record<string,any>};
  }
  const identity=(tenant:string,id=conversationId)=>({tenantId:tenant,conversationId:id});
  const enqueue=(stub:Stub,tenant:string,requestId:string,userContent:string)=>post(stub,"/enqueue",{...identity(tenant),requestId,userContent,mode:"general",title:"Test chat"});

  it("enqueues once per requestId and rejects conflicting reuse",async()=>{
    const {stub}=await boot();
    const object=stub(tenantA);
    const first=await enqueue(object,tenantA,"request-0001","Привет");
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ok:true,duplicate:false,state:"queued",sequence:1});
    const duplicate=await enqueue(object,tenantA,"request-0001","Привет");
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toMatchObject({ok:true,duplicate:true,state:"queued",sequence:1});
    const conflict=await enqueue(object,tenantA,"request-0001","Другое сообщение");
    expect(conflict.status).toBe(409);
    const conversation=await get(object,"/conversation?tenantId="+tenantA+"&conversationId="+conversationId);
    expect(conversation.status).toBe(200);
    expect(conversation.body.conversation.messages).toEqual([]);
  });

  it("serializes same-conversation requests in FIFO order and persists each pair once",async()=>{
    const {stub}=await boot();
    const object=stub(tenantA);
    await enqueue(object,tenantA,"request-0001","Первое");
    await enqueue(object,tenantA,"request-0002","Второе");

    const [claimA,duplicateA]=await Promise.all([
      post(object,"/claim",{...identity(tenantA),requestId:"request-0001"}),
      post(object,"/claim",{...identity(tenantA),requestId:"request-0001"}),
    ]);
    expect([claimA.status,duplicateA.status].sort()).toEqual([200,202]);
    const tokenA=Number(claimA.body.fencingToken);
    const blockedB=await post(object,"/claim",{...identity(tenantA),requestId:"request-0002"});
    expect(blockedB.status).toBe(202);
    expect(blockedB.body).toMatchObject({state:"queued",blockedBy:"request-0001"});

    expect((await post(object,"/provider-started",{...identity(tenantA),requestId:"request-0001",fencingToken:tokenA})).status).toBe(200);
    const doneA=await post(object,"/finalize",{...identity(tenantA),requestId:"request-0001",fencingToken:tokenA,answer:"Ответ один"});
    expect(doneA.status).toBe(200);
    const claimB=await post(object,"/claim",{...identity(tenantA),requestId:"request-0002"});
    expect(claimB.body.state).toBe("claimed");
    const tokenB=Number(claimB.body.fencingToken);
    await post(object,"/provider-started",{...identity(tenantA),requestId:"request-0002",fencingToken:tokenB});
    const doneB=await post(object,"/finalize",{...identity(tenantA),requestId:"request-0002",fencingToken:tokenB,answer:"Ответ два"});
    expect(doneB.status).toBe(200);

    const conversation=await get(object,"/conversation?tenantId="+tenantA+"&conversationId="+conversationId);
    expect(conversation.body.conversation.messages.map((m:any)=>[m.role,m.content])).toEqual([
      ["user","Первое"],["assistant","Ответ один"],["user","Второе"],["assistant","Ответ два"],
    ]);
    const replay=await post(object,"/finalize",{...identity(tenantA),requestId:"request-0002",fencingToken:tokenB,answer:"Ответ два"});
    expect(replay.body).toMatchObject({ok:true,duplicate:true,state:"completed"});
  });

  it("isolates equal conversation UUIDs across tenants and rejects cross-tenant calls",async()=>{
    const {stub}=await boot();
    const a=stub(tenantA);
    const b=stub(tenantB);
    await enqueue(a,tenantA,"request-tenant-a","История A");
    const foreign=await post(a,"/claim",{...identity(tenantB),requestId:"request-tenant-a"});
    expect(foreign.status).toBe(403);
    const other=await get(b,"/status?tenantId="+tenantB+"&conversationId="+conversationId+"&requestId=request-tenant-a");
    expect(other.status).toBe(404);
    await enqueue(b,tenantB,"request-tenant-b","История B");
    const ownA=await get(a,"/status?tenantId="+tenantA+"&conversationId="+conversationId+"&requestId=request-tenant-a");
    const ownB=await get(b,"/status?tenantId="+tenantB+"&conversationId="+conversationId+"&requestId=request-tenant-b");
    expect(ownA.body.state).toBe("queued");
    expect(ownB.body.state).toBe("queued");
  });

  it("uses lease fencing so a stale processor cannot finalize after reclaim",async()=>{
    const {stub}=await boot();
    const object=stub(tenantA);
    await enqueue(object,tenantA,"request-fence-01","Fence me");
    const first=await post(object,"/claim",{...identity(tenantA),requestId:"request-fence-01",leaseMs:1000});
    const oldToken=Number(first.body.fencingToken);
    await new Promise(resolve=>setTimeout(resolve,1_050));
    const second=await post(object,"/claim",{...identity(tenantA),requestId:"request-fence-01",leaseMs:10_000});
    const newToken=Number(second.body.fencingToken);
    expect(newToken).toBeGreaterThan(oldToken);
    const stale=await post(object,"/finalize",{...identity(tenantA),requestId:"request-fence-01",fencingToken:oldToken,answer:"Stale"});
    expect(stale.status).toBe(409);
    await post(object,"/provider-started",{...identity(tenantA),requestId:"request-fence-01",fencingToken:newToken});
    const current=await post(object,"/finalize",{...identity(tenantA),requestId:"request-fence-01",fencingToken:newToken,answer:"Current"});
    expect(current.status).toBe(200);
  });

  it("marks expired provider calls unknown and never reclaims them automatically",async()=>{
    const {stub}=await boot();
    const object=stub(tenantA);
    await enqueue(object,tenantA,"request-unknown-1","Maybe sent");
    const claim=await post(object,"/claim",{...identity(tenantA),requestId:"request-unknown-1",leaseMs:1000});
    const token=Number(claim.body.fencingToken);
    await post(object,"/provider-started",{...identity(tenantA),requestId:"request-unknown-1",fencingToken:token});
    await new Promise(resolve=>setTimeout(resolve,1_050));
    const recovered=await post(object,"/internal/alarm",identity(tenantA));
    expect(recovered.status).toBe(200);
    const status=await get(object,"/status?tenantId="+tenantA+"&conversationId="+conversationId+"&requestId=request-unknown-1");
    expect(status.body.state).toBe("provider_outcome_unknown");
    const retry=await post(object,"/claim",{...identity(tenantA),requestId:"request-unknown-1"});
    expect(retry.status).toBe(409);
    expect(retry.body.state).toBe("provider_outcome_unknown");
  });

  it("requeues expired claims that never crossed the provider boundary",async()=>{
    const {stub}=await boot();
    const object=stub(tenantA);
    await enqueue(object,tenantA,"request-recover-01","Not sent");
    await post(object,"/claim",{...identity(tenantA),requestId:"request-recover-01",leaseMs:1000});
    await new Promise(resolve=>setTimeout(resolve,1_050));
    const recovered=await post(object,"/internal/alarm",identity(tenantA));
    expect(recovered.status).toBe(200);
    const status=await get(object,"/status?tenantId="+tenantA+"&conversationId="+conversationId+"&requestId=request-recover-01");
    expect(status.body.state).toBe("queued");
    const retry=await post(object,"/claim",{...identity(tenantA),requestId:"request-recover-01"});
    expect(retry.body.state).toBe("claimed");
  });

  it("uses bounded exponential backoff for alarm recovery failures",async()=>{
    const {companionAlarmBackoffMs}=await import("../src/companion-conversations");
    expect(companionAlarmBackoffMs(0)).toBe(1000);
    expect(companionAlarmBackoffMs(1)).toBe(2000);
    expect(companionAlarmBackoffMs(5)).toBe(32000);
    expect(companionAlarmBackoffMs(8)).toBe(60000);
    expect(companionAlarmBackoffMs(99)).toBe(60000);
  });

  it("keeps completed history durable across Durable Object eviction/restart",async()=>{
    const first=await boot();
    const object=first.stub(tenantA);
    await enqueue(object,tenantA,"request-restart-1","Persist me");
    const claim=await post(object,"/claim",{...identity(tenantA),requestId:"request-restart-1"});
    const token=Number(claim.body.fencingToken);
    await post(object,"/provider-started",{...identity(tenantA),requestId:"request-restart-1",fencingToken:token});
    await post(object,"/finalize",{...identity(tenantA),requestId:"request-restart-1",fencingToken:token,answer:"Saved"});
    await first.dispose();
    const second=await boot();
    const history=await get(second.stub(tenantA),"/conversation?tenantId="+tenantA+"&conversationId="+conversationId);
    expect(history.body.conversation.messages.map((m:any)=>m.content)).toEqual(["Persist me","Saved"]);
  });

  it("rejects finalize after lease expiry even before another worker reclaims it",async()=>{
    const {stub}=await boot();
    const object=stub(tenantA);
    await enqueue(object,tenantA,"request-expired-finalize","Slow provider");
    const claim=await post(object,"/claim",{...identity(tenantA),requestId:"request-expired-finalize",leaseMs:1000});
    const token=Number(claim.body.fencingToken);
    await post(object,"/provider-started",{...identity(tenantA),requestId:"request-expired-finalize",fencingToken:token});
    await new Promise(resolve=>setTimeout(resolve,1_050));
    const late=await post(object,"/finalize",{...identity(tenantA),requestId:"request-expired-finalize",fencingToken:token,answer:"Late result"});
    expect(late.status).toBe(409);
    expect(late.body.state).toBe("provider_outcome_unknown");
  });

});
