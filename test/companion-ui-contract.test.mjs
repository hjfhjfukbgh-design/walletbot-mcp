import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source=readFileSync(new URL("../miniapp/web/kripto-guru-ui.js",import.meta.url),"utf8");
const sendBlock=source.slice(source.indexOf("  async function pollCompanionRequest"),source.indexOf("\n  function renderProfileSettings()",source.indexOf("  async function pollCompanionRequest")));

describe("Companion Mini App request lifecycle contract",()=>{
  it("creates one requestId and conversationId per logical send and reuses both on retries",()=>{
    expect(sendBlock).toMatch(/requestId:companionRequestUuid\(\)/);
    expect(sendBlock).toMatch(/conversationId:state\.companionId\|\|companionRequestUuid\(\)/);
    expect(sendBlock).toMatch(/invoke\("companion\.send",pending\.message,pending\.conversationId,pending\.attachments,pending\.mode,pending\.requestId\)/);
    expect(sendBlock).toMatch(/pending\.requestId/);
    expect(sendBlock).toMatch(/state\.companionPending=pending/);
  });

  it("polls queued and processing states with bounded backoff",()=>{
    expect(sendBlock).toMatch(/const delays=\[500,750,1000,1500,2000,2500,3000,4000,4000,5000\]/);
    expect(sendBlock).toMatch(/invoke\("companion\.status",pending\.conversationId,pending\.requestId\)/);
    expect(sendBlock).toMatch(/status\?\.state==="queued"/);
    expect(sendBlock).toMatch(/status\?\.state==="processing"/);
    expect(sendBlock).toMatch(/attempt<delays\.length/);
  });

  it("handles completed, failed and provider-outcome-unknown as distinct terminal states",()=>{
    expect(sendBlock).toMatch(/status\?\.state==="completed"/);
    expect(sendBlock).toMatch(/status\?\.state==="failed"/);
    expect(sendBlock).toMatch(/status\?\.state==="provider_outcome_unknown"/);
    expect(sendBlock).toMatch(/PROVIDER_OUTCOME_UNKNOWN/);
    expect(sendBlock).toMatch(/COMPANION_FAILED/);
  });

  it("retains the same pending request after bounded timeout and blocks duplicate UI sends",()=>{
    expect(sendBlock).toMatch(/code:"PENDING_TIMEOUT"/);
    expect(sendBlock).toMatch(/if\(normalized\.code!=="PENDING_TIMEOUT"\)state\.companionPending=null/);
    expect(sendBlock).toMatch(/state\.companionBusy\)return/);
    expect(sendBlock).toMatch(/pending\.inputMessage!==inputMessage/);
  });
});
