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

/** `content` is a trusted HTML slot; escape all untrusted text before composing it. */
export function islandMarkup(content, { className = "", label = "" } = {}) {
  const classes = ["kg-island", ...String(className).split(/\s+/).filter(Boolean)].map(escapeHTML).join(" ");
  const aria = label ? ` aria-label="${escapeHTML(label)}"` : "";
  return `<section class="${classes}"${aria}>${String(content ?? "")}</section>`;
}

export function listRowMarkup({ title, subtitle = "", value = "", icon = "", action = "", disabled = false } = {}) {
  const tag = action ? "button" : "div";
  const actionAttr = tag === "button" ? ` type="button" data-action="${escapeHTML(action)}"` : "";
  const disabledAttr = disabled ? (tag === "button" ? " disabled aria-disabled=\"true\"" : " aria-disabled=\"true\"") : "";
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


/** iOS-style settings row with a constrained, colored icon tile. */
export function settingsRowMarkup({ title, value = "", subtitle = "", icon = "", iconColor = "#8e8e93", action = "", disabled = false } = {}) {
  const tag = action ? "button" : "div";
  const color = /^#[0-9a-f]{6}$/i.test(String(iconColor)) ? iconColor : "#8e8e93";
  const attrs = tag === "button" ? ` type="button" data-action="${escapeHTML(action)}"` : "";
  const state = disabled ? (tag === "button" ? ' disabled aria-disabled="true"' : ' aria-disabled="true"') : "";
  return `<${tag} class="kg-settings-row${disabled ? " is-disabled" : ""}"${attrs}${state}><span class="kg-settings-row__icon" style="--kg-settings-icon-color:${color}" aria-hidden="true">${escapeHTML(icon)}</span><span class="kg-settings-row__copy"><span class="kg-settings-row__title">${escapeHTML(title)}</span>${subtitle ? `<span class="kg-settings-row__subtitle">${escapeHTML(subtitle)}</span>` : ""}</span>${value !== "" ? `<span class="kg-settings-row__value">${escapeHTML(value)}</span>` : ""}<span class="kg-settings-row__chevron" aria-hidden="true">›</span></${tag}>`;
}

/** Compact 56×24 SVG sparkline; invalid or insufficient points render an honest empty value. */
export function sparklineMarkup(points, { positive = null, label = "Изменение" } = {}) {
  const values = (Array.isArray(points) ? points : []).map(Number).filter(Number.isFinite);
  if (values.length < 2) return `<span class="kg-sparkline kg-sparkline--empty" aria-label="${escapeHTML(label)}">—</span>`;
  const min = Math.min(...values), max = Math.max(...values), range = max - min || 1;
  const coords = values.map((value, index) => {
    const x = 1 + index * 54 / (values.length - 1);
    const y = 22 - (value - min) * 20 / range;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const rising = positive === null ? values[values.length - 1] >= values[0] : Boolean(positive);
  return `<svg class="kg-sparkline ${rising ? "kg-sparkline--positive" : "kg-sparkline--negative"}" width="56" height="24" viewBox="0 0 56 24" role="img" aria-label="${escapeHTML(label)}"><polyline points="${coords}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

export function glassPillMarkup({ label, action = "", icon = "", disabled = false } = {}) {
  const state = disabled ? ' disabled aria-disabled="true"' : ` data-action="${escapeHTML(action)}"`;
  return `<button type="button" class="kg-glass-pill"${state}>${icon ? `<span aria-hidden="true">${escapeHTML(icon)}</span>` : ""}<span>${escapeHTML(label)}</span></button>`;
}

export function roundIconButtonMarkup({ label, icon = "", action = "", disabled = false } = {}) {
  const state = disabled ? ' disabled aria-disabled="true"' : ` data-action="${escapeHTML(action)}"`;
  return `<button type="button" class="kg-round-icon-button"${state} aria-label="${escapeHTML(label)}"><span aria-hidden="true">${escapeHTML(icon)}</span></button>`;
}

export function heatmapTileMarkup({ symbol, changePct = null, volume = null, action = "" } = {}) {
  const change = Number(changePct), valid = changePct !== null && changePct !== undefined && changePct !== "" && Number.isFinite(change);
  const hasVolume = volume !== null && volume !== undefined && volume !== "" && Number.isFinite(Number(volume));
  const state = !valid || change === 0 ? "neutral" : change > 0 ? "positive" : "negative";
  const changeText = valid ? `${change > 0 ? "+" : ""}${change.toFixed(2)}%` : "—";
  const volumeText = hasVolume ? new Intl.NumberFormat("ru-RU", { notation: "compact", maximumFractionDigits: 1 }).format(Number(volume)) : "—";
  const tag = action ? "button" : "div";
  const attrs = action ? ` type="button" data-action="${escapeHTML(action)}"` : "";
  return `<${tag} class="kg-heatmap-tile kg-heatmap-tile--${state}" data-volume="${hasVolume ? Number(volume) : ""}"${attrs}><strong>${escapeHTML(symbol)}</strong><span>${changeText}</span><small>${escapeHTML(volumeText)}</small></${tag}>`;
}

/** `content` is a trusted HTML slot; escape dynamic text before composing markup. */
export function bottomSheetMarkup(content, { title = "", open = false, labelledBy = "" } = {}) {
  const hidden = open ? "" : " hidden";
  const aria = labelledBy ? ` aria-labelledby="${escapeHTML(labelledBy)}"` : ` aria-label="${escapeHTML(title)}"`;
  return `<section class="kg-bottom-sheet${open ? " is-open" : ""}" role="dialog" aria-modal="true"${aria}${hidden}><div class="kg-bottom-sheet__handle" aria-hidden="true"></div>${title ? `<h2 class="kg-bottom-sheet__title">${escapeHTML(title)}</h2>` : ""}<div class="kg-bottom-sheet__content">${String(content ?? "")}</div></section>`;
}

export function floatingTabBarMarkup(items, active, { label = "Основная навигация" } = {}) {
  const tabs = (Array.isArray(items) ? items : []).map(item => {
    const value = String(item?.value ?? ""), selected = value === String(active);
    return `<button type="button" class="kg-floating-tab${selected ? " is-active" : ""}" data-action="${escapeHTML(item?.action ?? value)}" aria-current="${selected ? "page" : "false"}"><span class="kg-floating-tab__icon" aria-hidden="true">${escapeHTML(item?.icon ?? "")}</span><span class="kg-floating-tab__label">${escapeHTML(item?.label ?? value)}</span></button>`;
  }).join("");
  return `<nav class="kg-floating-tab-bar" aria-label="${escapeHTML(label)}">${tabs}</nav>`;
}

export function toastMarkup(message, { variant = "info" } = {}) {
  const safe = ["info", "success", "error"].includes(variant) ? variant : "info";
  return `<div class="kg-toast kg-toast--${safe}" role="status">${escapeHTML(message)}</div>`;
}

export function errorBannerMarkup(message, { action = "", actionLabel = "Повторить" } = {}) {
  const retry = action ? `<button type="button" data-action="${escapeHTML(action)}" class="kg-error-banner__action">${escapeHTML(actionLabel)}</button>` : "";
  return `<div class="kg-error-banner" role="alert"><span>${escapeHTML(message)}</span>${retry}</div>`;
}

export const KGDesign = Object.freeze({
  modeBadgeMarkup, islandMarkup, listRowMarkup, settingsRowMarkup, actionTileMarkup,
  pnlChipMarkup, sparklineMarkup, glassPillMarkup, roundIconButtonMarkup,
  heatmapTileMarkup, bottomSheetMarkup, floatingTabBarMarkup, toastMarkup,
  errorBannerMarkup, emptyStateMarkup, skeletonMarkup, segmentedMarkup, buttonMarkup,
});

if (typeof window !== "undefined") window.KGDesign = KGDesign;
