import type { ContractInfo } from "./strategy/grid";
import { riskLimits, type Env } from "./env";
import { marketAllowed } from "./risk";
import { publicContracts } from "./prices";
import { parseAiPaperDecision } from "./service";

type Json = Record<string, unknown>;
type SnapshotMarket = { symbol: string; price: string; volume24hUsd: number };
type AiPaperDependencies = {
  now?: () => number;
  getContracts?: () => Promise<ContractInfo[]>;
  fetcher?: typeof fetch;
  engineRequest?: (path: string, body?: Json) => Promise<Response>;
  consumeQuota?: (quotas: Array<{ key: string; limit: number; windowSeconds: number; sliding?: boolean }>) => Promise<Response>;
  isAiMode?: () => Promise<boolean>;
};
const MAX_MARKETS_IN_PROMPT = 10;
const MAX_MARK_AGE_MS = 10 * 60_000;

function response(data: unknown, status = 200): Response { return Response.json(data, { status }); }
function serverRiskConfigValid(env: Env): boolean {
  return [env.MAX_ORDER_PCT, env.MAX_TOTAL_EXPOSURE_PCT, env.MAX_DAILY_LOSS_PCT].every((value) => {
    const parsed = Number(value);
    return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed > 0 && parsed <= 100;
  });
}
function symbolOf(contract: ContractInfo): string {
  return String(contract.name ?? "").toUpperCase().replace(/-(?:USDC|USD|USDT)$/i, "");
}
function formatPrice(value: number, decimals: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const precision = Number.isSafeInteger(decimals) ? Math.max(0, Math.min(8, decimals)) : 8;
  const formatted = value.toFixed(precision);
  return /^(?:0|[1-9]\d{0,15})(?:\.\d{1,8})?$/.test(formatted) && Number(formatted) > 0 ? formatted : null;
}
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function defaultEngineRequest(env: Env, path: string, body?: Json): Promise<Response> {
  const namespace = env.ENGINE;
  const stub = namespace.get(namespace.idFromName("global-engine"));
  const request = body === undefined
    ? new Request("https://engine.internal" + path)
    : new Request("https://engine.internal" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return stub.fetch(request);
}
async function defaultConsumeQuota(env: Env, quotas: Array<{ key: string; limit: number; windowSeconds: number; sliding?: boolean }>): Promise<Response> {
  const namespace = env.COMPANION_QUOTA;
  const stub = namespace.get(namespace.idFromName("global"));
  return stub.fetch("https://companion-quota/consume", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ quotas }),
  });
}

/** Generate and persist one AI PAPER decision. Never opens or closes positions. */
export async function runAiPaperDecision(env: Env, userId: string, requestId: unknown, dependencies: AiPaperDependencies = {}): Promise<Response> {
  if (!/^\d{1,20}$/.test(userId)) return response({ ok: false, error: "Не подтверждён пользователь Telegram." }, 401);
  const tickId = typeof requestId === "string" ? requestId.trim() : "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(tickId))
    return response({ ok: false, error: "Передайте стабильный requestId для запуска AI PAPER." }, 400);

  const now = dependencies.now ?? Date.now;
  const engineRequest = dependencies.engineRequest ?? ((path, body) => defaultEngineRequest(env, path, body));
  const consumeQuota = dependencies.consumeQuota ?? ((quotas) => defaultConsumeQuota(env, quotas));
  const getContracts = dependencies.getContracts ?? publicContracts;
  const fetcher = dependencies.fetcher ?? fetch;

  // Replay durable decisions before checking session state, API keys, quota or market data.
  let lookupResponse: Response;
  try {
    lookupResponse = await engineRequest("/ai/paper/decision?userId=" + encodeURIComponent(userId) + "&tickId=" + encodeURIComponent(tickId));
  } catch {
    return response({ ok: false, error: "Не удалось проверить повторный запуск AI PAPER. Запрос не отправлен." }, 503);
  }
  if (lookupResponse.ok) {
    const existing = await lookupResponse.json().catch(() => ({})) as Json;
    const decision = existing.decision as Json | undefined;
    if (existing.state !== "completed" || !decision)
      return response({ ok: false, error: "Некорректный ответ хранилища AI PAPER." }, 503);
    return response({
      ok: true,
      tickId,
      marketSnapshotHash: decision.marketSnapshotHash,
      snapshotRetrievedAt: decision.snapshotRetrievedAt,
      decision: {
        signal: decision.signal,
        symbol: decision.symbol,
        rationale: decision.rationale,
        confidence: decision.confidence,
        snapshotPayload: decision.snapshotPayload,
      },
      persisted: true,
      duplicate: true,
    }, 200);
  }
  if (lookupResponse.status === 409) {
    const pending = await lookupResponse.json().catch(() => ({})) as Json;
    return response({ ok: false, state: pending.state ?? "in_progress", error: String(pending.error ?? "Запуск AI PAPER ещё не завершён.") }, 409);
  }
  if (lookupResponse.status !== 404)
    return response({ ok: false, error: "Не удалось проверить историю AI PAPER. Запрос не отправлен." }, 503);

  if (dependencies.isAiMode) {
    let enabled = false;
    try { enabled = await dependencies.isAiMode(); }
    catch { return response({ ok: false, error: "Не удалось проверить выбранный способ торговли. Запуск отменён." }, 503); }
    if (!enabled) return response({ ok: false, error: "Выберите AI Piper перед новым запуском AI PAPER." }, 409);
  }

  if (!env.GEMINI_API_KEY) return response({ ok: false, error: "Gemini временно не настроен." }, 503);
  if (!serverRiskConfigValid(env)) return response({ ok: false, error: "Серверные лимиты AI PAPER не настроены корректно." }, 503);

  let statusResponse: Response;
  try { statusResponse = await engineRequest("/ai/paper/status?userId=" + encodeURIComponent(userId)); }
  catch { return response({ ok: false, error: "Не удалось проверить AI PAPER сессию. Запуск отменён." }, 503); }
  if (!statusResponse.ok) return response({ ok: false, error: "Не удалось проверить AI PAPER счёт. Запуск отменён." }, 503);
  const account = await statusResponse.json().catch(() => ({})) as Json;
  if (account.status !== "active") return response({ ok: false, error: "Сначала явно запустите AI PAPER сессию." }, 409);

  let contracts: ContractInfo[];
  try { contracts = await getContracts(); }
  catch { return response({ ok: false, error: "Рыночный источник временно недоступен. Решение не создано." }, 503); }

  const limits = riskLimits(env);
  const markets: SnapshotMarket[] = contracts
    .map((contract) => ({ contract, symbol: symbolOf(contract), volume: Number(contract.volume24hUsd ?? 0) }))
    .filter(({ contract, symbol, volume }) =>
      /^[A-Z0-9]{2,20}$/.test(symbol) && marketAllowed(limits, symbol) &&
      Number.isFinite(volume) && volume >= limits.minVolume24hUsd &&
      Number.isFinite(Number(contract.price)) && Number(contract.price) > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, MAX_MARKETS_IN_PROMPT)
    .map(({ contract, symbol, volume }) => ({
      symbol, price: formatPrice(Number(contract.price), Number(contract.priceDecimals ?? 8)) ?? "",
      volume24hUsd: volume,
    }))
    .filter((market) => market.price !== "");
  if (!markets.length) return response({ ok: false, error: "Нет рынков с валидной котировкой и серверным allowlist." }, 503);

  // Hyperliquid's public contract response has no per-quote source timestamp;
  // this records when the Worker retrieved the data, not an exchange-observed time.
  const snapshotRetrievedAt = now();
  const snapshotPayload = { source: "hyperliquid-public", retrievedAt: snapshotRetrievedAt, markets };
  const marketSnapshotHash = await sha256Hex(JSON.stringify(snapshotPayload));
  const utcDay = new Date(snapshotRetrievedAt).toISOString().slice(0, 10);

  // One durable claim per (Telegram userId, tickId) prevents concurrent retries
  // from consuming quota or invoking Gemini more than once.
  let claimResponse: Response;
  try {
    claimResponse = await engineRequest("/ai/paper/decision/claim", { userId, tickId });
  } catch {
    return response({ ok: false, error: "Не удалось зарезервировать запуск AI PAPER. Запрос не отправлен." }, 503);
  }
  const claimBody = await claimResponse.json().catch(() => ({})) as Json;
  if (claimResponse.status === 409)
    return response({ ok: false, state: claimBody.state ?? "in_progress", error: String(claimBody.error ?? "Этот запуск AI PAPER ещё не завершён.") }, 409);
  if (!claimResponse.ok || claimBody.state !== "claimed") {
    if (claimBody.state === "completed" && claimBody.decision) {
      const decision = claimBody.decision as Json;
      return response({
        ok: true, tickId, marketSnapshotHash: decision.marketSnapshotHash, snapshotRetrievedAt: decision.snapshotRetrievedAt,
        decision: { signal: decision.signal, symbol: decision.symbol, rationale: decision.rationale, confidence: decision.confidence, snapshotPayload: decision.snapshotPayload },
        persisted: true, duplicate: true,
      }, 200);
    }
    return response({ ok: false, error: "Не удалось подтвердить запуск AI PAPER. Запрос не отправлен." }, 503);
  }

  const fencingToken = Number(claimBody.fencingToken);
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1)
    return response({ ok: false, error: "Хранилище не вернуло fencing token. Запуск отменён." }, 503);

  let persisted = false;
  let externalAttempted = false;
  let released = false;
  try {
    const model = (env.GEMINI_MODEL || "gemini-3.5-flash-lite").trim();
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) return response({ ok: false, error: "Некорректная настройка модели Gemini." }, 503);

    // Persist the start of the external side-effect before quota/Gemini. If the
    // Worker dies after this point, the same requestId must not call either again.
    externalAttempted = true;
    const startedResponse = await engineRequest("/ai/paper/decision/external-started", { userId, tickId, fencingToken });
    if (!startedResponse.ok) return response({ ok: false, error: "Запуск AI PAPER больше не принадлежит этому исполнителю." }, 409);

    let quotaResponse: Response;
    try {
      quotaResponse = await consumeQuota([
        { key: "ai-paper:global:" + utcDay, limit: 20, windowSeconds: 86_400 },
        { key: "ai-paper:user:" + userId + ":" + utcDay, limit: 5, windowSeconds: 86_400 },
        { key: "ai-paper:rate:" + userId, limit: 1, windowSeconds: 60, sliding: true },
      ]);
    } catch { return response({ ok: false, error: "Лимитер Gemini недоступен. Запрос не отправлен." }, 503); }
    if (quotaResponse.status === 429) {
      try {
        const releaseResponse = await engineRequest("/ai/paper/decision/release", { userId, tickId, fencingToken, safeToRetry: true });
        released = releaseResponse.ok;
      } catch {}
      return response({ ok: false, error: "Бесплатный лимит AI PAPER на сегодня исчерпан. Попробуйте позже." }, 429);
    }
    if (!quotaResponse.ok) return response({ ok: false, error: "Не удалось подтвердить бесплатную квоту Gemini. Повтор заблокирован до проверки состояния." }, 503);

    const systemPrompt = [
      "Ты формируешь только аналитическое решение для AI PAPER Kripto Guru.",
      "Используй исключительно переданный серверный снимок рынка. Не придумывай цены и не используй внешние данные.",
      "Выбери один символ из списка и верни строго JSON с четырьмя полями: signal (buy|sell|hold), symbol, rationale, confidence (0..1).",
      "Не добавляй markdown, кодовые блоки или другие поля.",
      "Не задавай userId, tenantId, observedPrice, riskPass, positionId, leverage, quantity, margin, fees, slippage или лимиты риска.",
      "Это только решение для виртуального AI PAPER счёта; не утверждай, что ордер исполнен.",
    ].join(" ");

    let modelResponse: Response;
    try {
      modelResponse = await fetcher("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: "Серверный снимок рынка JSON:\n" + JSON.stringify(snapshotPayload) }] }],
          generationConfig: {
            temperature: 0.1, maxOutputTokens: 256, responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                signal: { type: "STRING", enum: ["buy", "sell", "hold"] },
                symbol: { type: "STRING" }, rationale: { type: "STRING" }, confidence: { type: "NUMBER" },
              },
              required: ["signal", "symbol", "rationale", "confidence"],
              propertyOrdering: ["signal", "symbol", "rationale", "confidence"],
            },
          },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
          ],
        }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { return response({ ok: false, error: "Gemini не ответил вовремя. Решение не создано." }, 503); }
    if (!modelResponse.ok) return response({ ok: false, error: "Gemini временно отклонил запрос. Решение не создано." }, 503);

    const payload = await modelResponse.json().catch(() => ({})) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const candidate = payload.candidates?.[0];
    if (!candidate || candidate.finishReason !== "STOP")
      return response({ ok: false, error: "Gemini не завершил ответ корректным образом. Решение не создано." }, 502);
    const raw = candidate.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const parsed = parseAiPaperDecision(raw, markets.map((market) => market.symbol));
    if (!parsed.ok) return response({ ok: false, error: "Gemini вернул некорректное решение: " + parsed.reason }, 502);

    const selected = markets.find((market) => market.symbol === parsed.decision.symbol);
    const recordedAt = now();
    if (!selected || !Number.isSafeInteger(snapshotRetrievedAt) || snapshotRetrievedAt <= 0 ||
        snapshotRetrievedAt > recordedAt || recordedAt - snapshotRetrievedAt > MAX_MARK_AGE_MS)
      return response({ ok: false, error: "Снимок рынка устарел до завершения анализа. Решение не создано." }, 409);

    const recordResponse = await engineRequest("/ai/paper/decision", {
      userId, tickId, fencingToken, strategyId: "gemini-paper", strategyVersion: "1", marketSnapshotHash,
      symbol: parsed.decision.symbol, signal: parsed.decision.signal, rationale: parsed.decision.rationale,
      confidence: parsed.decision.confidence, observedPrice: selected.price,
      snapshotRetrievedAt, snapshotPayload,
      riskPass: false, riskEvaluated: false, rejectionReason: null, positionId: null,
    });
    const recordBody = await recordResponse.json().catch(() => ({})) as Json;
    if (!recordResponse.ok)
      return response({ ok: false, error: String(recordBody.error ?? "Не удалось сохранить AI PAPER решение."), tickId }, recordResponse.status);
    persisted = true;
    return response({
      ok: true, tickId, marketSnapshotHash, snapshotRetrievedAt,
      decision: { ...parsed.decision, snapshotPayload }, persisted: true, duplicate: recordBody.duplicate === true,
    }, recordResponse.status);
  } finally {
    if (!persisted && !released) {
      try {
        if (externalAttempted)
          await engineRequest("/ai/paper/decision/unknown", { userId, tickId, fencingToken });
        else
          await engineRequest("/ai/paper/decision/release", { userId, tickId, fencingToken });
      } catch {}
    }
  }
}
