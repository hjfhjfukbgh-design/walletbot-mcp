/**
 * Kripto Guru — safe, framework-free UI primitives.
 *
 * These renderers intentionally emit semantic markup only. All dynamic text and
 * attributes are escaped; icons are text glyphs supplied by trusted callers.
 * Visual styling lives in the companion kripto-guru-components.css file.
 */
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);

const MODE = Object.freeze({
  demo: { label: "ДЕМО", description: "виртуальные деньги", className: "demo" },
  live: { label: "LIVE", description: "реальные средства", className: "live" },
  ai: { label: "ИИ", description: "виртуальный счёт", className: "ai" },
});

export function modeBadgeMarkup(mode, { compact = false } = {}) {
  const item = MODE[String(mode || "").toLowerCase()];
  if (!item) return "";
  const detail = compact ? "" : `<span class="kg-mode-badge__description">${item.description}</span>`;
  return `<span class="kg-mode-badge kg-mode-badge--${item.className}" data-mode="${item.className}"><span class="kg-mode-badge__label">${item.label}</span>${detail}</span>`;
}

export function islandMarkup(content, { className = "", label = "" } = {}) {
  const classes = ["kg-island", ...String(className).split(/\\s+/).filter(Boolean)].map(escapeHTML).join(" ");
  const aria = label ? ` aria-label="${escapeHTML(label)}"` : "";
  return `<section class="${classes}"${aria}>${String(content ?? "")}</section>`;
}

export function listRowMarkup({ title, subtitle = "", value = "", icon = "", action = "", disabled = false } = {}) {
  const tag = action && !disabled ? "button" : "div";
  const actionAttr = tag === "button" ? ` type="button" data-action="${escapeHTML(action)}"` : "";
  const disabledAttr = disabled && tag === "button" ? " disabled aria-disabled=\"true\"" : "";
  const iconMarkup = icon ? `<span class="kg-list-row__icon" aria-hidden="true">${escapeHTML(icon)}</span>` : "";
  const subtitleMarkup = subtitle ? `<span class="kg-list-row__subtitle">${escapeHTML(subtitle)}</span>` : "";
  const valueMarkup = value !== "" ? `<span class="kg-list-row__value">${escapeHTML(value)}</span>` : "";
  return `<${tag} class="kg-list-row${disabled ? " is-disabled" : ""}"${actionAttr}${disabledAttr}>${iconMarkup}<span class="kg-list-row__copy"><span class="kg-list-row__title">${escapeHTML(title)}</span>${subtitleMarkup}</span>${valueMarkup}</${tag}>`;
}

export function actionTileMarkup({ label, icon = "", action = "", disabled = false, reason = "" } = {}) {
  const attrs = disabled ? ' disabled aria-disabled="true"' : ` data-action="${escapeHTML(action)}"`;
  const note = disabled && reason ? `<span class="kg-action-tile__reason">${escapeHTML(reason)}</span>` : "";
  return `<button class="kg-action-tile${disabled ? " is-disabled" : ""}" type="button"${attrs}><span class="kg-action-tile__icon" aria-hidden="true">${escapeHTML(icon)}</span><span class="kg-action-tile__label">${escapeHTML(label)}</span>${note}</button>`;
}

export function pnlChipMarkup(value, { positive = null, label = "" } = {}) {
  const numeric = Number(value);
  const state = positive === null ? (Number.isFinite(numeric) ? (numeric > 0 ? "positive" : numeric < 0 ? "negative" : "neutral") : "neutral") : (positive ? "positive" : "negative");
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  return `<span class="kg-pnl-chip kg-pnl-chip--${state}">${escapeHTML(label)}${escapeHTML(text)}</span>`;
}

export function emptyStateMarkup({ title, description = "", action = "", actionLabel = "" } = {}) {
  const actionMarkup = action && actionLabel ? `<button type="button" class="kg-empty-state__action" data-action="${escapeHTML(action)}">${escapeHTML(actionLabel)}</button>` : "";
  return `<div class="kg-empty-state"><span class="kg-empty-state__symbol" aria-hidden="true">◇</span><strong>${escapeHTML(title)}</strong><p>${escapeHTML(description)}</p>${actionMarkup}</div>`;
}

export function skeletonMarkup({ rows = 3, className = "" } = {}) {
  const count = Math.max(1, Math.min(8, Math.floor(Number(rows) || 3)));
  const safeClass = escapeHTML(className);
  const items = Array.from({ length: count }, () => '<span class="kg-skeleton__line" aria-hidden="true"></span>').join("");
  return `<div class="kg-skeleton ${safeClass}" aria-hidden="true">${items}</div>`;
}

export function segmentedMarkup(items, active, { label = "Выбор" } = {}) {
  const options = (Array.isArray(items) ? items : []).map((item) => {
    const value = String(item?.value ?? "");
    const text = String(item?.label ?? value);
    const selected = value === String(active);
    return `<button type="button" class="kg-segmented__item${selected ? " is-active" : ""}" data-value="${escapeHTML(value)}" aria-pressed="${selected ? "true" : "false"}">${escapeHTML(text)}</button>`;
  }).join("");
  return `<div class="kg-segmented" role="group" aria-label="${escapeHTML(label)}">${options}</div>`;
}

export function buttonMarkup({ label, action = "", variant = "primary", disabled = false, reason = "" } = {}) {
  const allowed = new Set(["primary", "long", "short", "ghost", "destructive"]);
  const safeVariant = allowed.has(variant) ? variant : "primary";
  const reasonMarkup = disabled && reason ? `<span class="kg-button__reason">${escapeHTML(reason)}</span>` : "";
  return `<button type="button" class="kg-button kg-button--${safeVariant}${disabled ? " is-disabled" : ""}" data-action="${escapeHTML(action)}"${disabled ? ' disabled aria-disabled="true"' : ""}>${escapeHTML(label)}${reasonMarkup}</button>`;
}

export const KGDesign = Object.freeze({
  modeBadgeMarkup, islandMarkup, listRowMarkup, actionTileMarkup, pnlChipMarkup,
  emptyStateMarkup, skeletonMarkup, segmentedMarkup, buttonMarkup,
});

if (typeof window !== "undefined") window.KGDesign = KGDesign;
