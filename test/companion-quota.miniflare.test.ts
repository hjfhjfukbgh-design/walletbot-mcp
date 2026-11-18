import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";

type Quota = { key: string; limit: number; windowSeconds: number; sliding?: boolean };
type Stub = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };

describe("CompanionQuota SQLite integration", () => {
  let source = "";
  let root = "";
  let mf: Miniflare | undefined;
  let sequence = 0;

  beforeAll(async () => {
    root = ".mf-companion-quota-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    const bundle = await build({
      entryPoints: ["src/companion-quota.ts"],
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
    });
    source = bundle.outputFiles[0].text + "\nexport default { fetch() { return new Response('ok'); } };";
  });

  afterAll(async () => {
    await mf?.dispose();
  });

  beforeEach(async () => {
    await mf?.dispose();
    mf = undefined;
    sequence++;
  });

  async function boot(): Promise<Stub> {
    mf = new Miniflare({
      workers: [{
        config: {
          name: "companion-quota-test",
          compatibilityDate: "2025-06-01",
          env: {
            COMPANION_QUOTA: { type: "durable-object", worker: "companion-quota-test", exportName: "CompanionQuota" },
          },
          exports: {
            CompanionQuota: { type: "durable-object", storage: "sqlite" },
          },
          manifest: {
            mainModule: "quota.mjs",
            modules: { "quota.mjs": { type: "esm", contents: source } },
          },
        },
      }],
      resourcePersistencePath: root + "-" + sequence,
    });
    const namespace = await mf.getDurableObjectNamespace("COMPANION_QUOTA");
    return namespace.get(namespace.idFromName("global")) as unknown as Stub;
  }

  async function consume(stub: Stub, quotas: Quota[]) {
    const response = await stub.fetch("https://quota.test/consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotas }),
    });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }

  it("atomically admits exactly the configured number under concurrent requests", async () => {
    const stub = await boot();
    const quota = { key: "rate:111", limit: 8, windowSeconds: 60, sliding: true };
    const results = await Promise.all(Array.from({ length: 24 }, () => consume(stub, [quota])));
    expect(results.filter(result => result.status === 200)).toHaveLength(8);
    expect(results.filter(result => result.status === 429)).toHaveLength(16);
  });

  it("reserves multiple limits atomically and does not consume rate quota when research quota is exhausted", async () => {
    const stub = await boot();
    const rate = { key: "rate:222", limit: 8, windowSeconds: 60, sliding: true };
    const global = { key: "research:global:2026-11-19", limit: 1, windowSeconds: 86_400 };
    const user = { key: "research:user:222:2026-11-19", limit: 5, windowSeconds: 86_400 };

    expect((await consume(stub, [rate, global, user])).status).toBe(200);
    expect((await consume(stub, [rate, global, user])).status).toBe(429);

    const remainingRateSlots = await Promise.all(Array.from({ length: 7 }, () => consume(stub, [rate])));
    expect(remainingRateSlots.every(result => result.status === 200)).toBe(true);
    expect((await consume(stub, [rate])).status).toBe(429);
  });

  it("enforces a true rolling window rather than resetting at a fixed minute boundary", async () => {
    const stub = await boot();
    const quota = { key: "rate:333", limit: 2, windowSeconds: 1, sliding: true };
    expect((await consume(stub, [quota])).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 600));
    expect((await consume(stub, [quota])).status).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 550));
    expect((await consume(stub, [quota])).status).toBe(200);
    expect((await consume(stub, [quota])).status).toBe(429);
  });

  it("rejects malformed quota requests", async () => {
    const stub = await boot();
    expect((await consume(stub, [])).status).toBe(400);
    expect((await consume(stub, [{ key: "bad key", limit: 1, windowSeconds: 60 }])).status).toBe(400);
    expect((await consume(stub, [{ key: "valid", limit: 0, windowSeconds: 60 }])).status).toBe(400);
    expect((await consume(stub, [{ key: "valid-sliding", limit: 1, windowSeconds: 60, sliding: "yes" as unknown as boolean }])).status).toBe(400);
  });
});
