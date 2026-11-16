const URL = "wss://api.hyperliquid.xyz/ws";
const DURATION_MS = 10 * 60_000;
const gaps = [];
let count = 0, firstAt = 0, lastAt = 0, connectedAt = 0;
let finished = false;

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}
function finish(reason) {
  if (finished) return;
  finished = true;
  const elapsedMs = lastAt && firstAt ? lastAt - firstAt : Date.now() - connectedAt;
  console.log(JSON.stringify({
    source: "Hyperliquid allMids",
    requestedDurationSeconds: DURATION_MS / 1000,
    elapsedSeconds: Math.round(elapsedMs / 1000),
    reason,
    messages: count,
    gaps: gaps.length,
    minGapMs: gaps.length ? Math.min(...gaps) : null,
    medianGapMs: percentile(gaps, 0.50),
    p95GapMs: percentile(gaps, 0.95),
    maxGapMs: gaps.length ? Math.max(...gaps) : null,
    averageMessagesPerSecond: elapsedMs > 0 ? Number((count / (elapsedMs / 1000)).toFixed(4)) : null,
    note: "Measured from this GitHub Actions runner; not a guaranteed feed SLA."
  }, null, 2));
  try { ws.close(); } catch {}
}
const ws = new WebSocket(URL);
const timer = setTimeout(() => finish("10-minute window completed"), DURATION_MS);
ws.addEventListener("open", () => {
  connectedAt = Date.now();
  ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "allMids" } }));
});
ws.addEventListener("message", (event) => {
  let message;
  try { message = JSON.parse(String(event.data)); } catch { return; }
  if (message.channel !== "allMids" || !message.data?.mids) return;
  const now = Date.now();
  if (!firstAt) firstAt = now;
  if (lastAt) gaps.push(now - lastAt);
  lastAt = now;
  count++;
});
ws.addEventListener("error", () => {
  clearTimeout(timer);
  finish("WebSocket error");
  process.exitCode = 1;
});
ws.addEventListener("close", () => {
  clearTimeout(timer);
  if (!finished) finish("WebSocket closed before 10 minutes");
});
process.on("SIGINT", () => {
  clearTimeout(timer);
  finish("interrupted");
});
