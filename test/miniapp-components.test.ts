import { describe, expect, it } from "vitest";
import {
  actionTileMarkup, bottomSheetMarkup, buttonMarkup, emptyStateMarkup, errorBannerMarkup,
  floatingTabBarMarkup, heatmapTileMarkup, islandMarkup, listRowMarkup, modeBadgeMarkup,
  pnlChipMarkup, segmentedMarkup, settingsRowMarkup, skeletonMarkup, sparklineMarkup,
  toastMarkup,
} from "../miniapp/web/kripto-guru-components.js";

describe("Kripto Guru UI primitives", () => {
  it("escapes untrusted labels and attributes", () => {
    const html = listRowMarkup({ title: '<img src=x onerror=alert(1)>', action: '" onclick="alert(1)' });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain('onclick="alert');
  });

  it("renders only known account modes", () => {
    expect(modeBadgeMarkup("demo")).toContain("ДЕМО");
    expect(modeBadgeMarkup("live")).toContain("реальные средства");
    expect(modeBadgeMarkup("ai", { compact: true })).toContain("ИИ");
    expect(modeBadgeMarkup("unknown")).toBe("");
  });

  it("renders accessible disabled actions with a reason", () => {
    const html = actionTileMarkup({ label: "Вывести", disabled: true, reason: "Недоступно в LIVE" });
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain("Недоступно в LIVE");
    expect(html).not.toContain('data-action=""');
  });

  it("keeps PnL states separate from neutral values", () => {
    expect(pnlChipMarkup("+1.2").includes("positive")).toBe(true);
    expect(pnlChipMarkup("-1.2").includes("negative")).toBe(true);
    expect(pnlChipMarkup("—").includes("neutral")).toBe(true);
  });

  it("bounds skeleton count and escapes component classes", () => {
    expect((skeletonMarkup({ rows: 100 }).match(/kg-skeleton__line/g) || []).length).toBe(8);
    expect(skeletonMarkup({ rows: 0 })).toContain("kg-skeleton__line");
  });

  it("renders selected segmented controls accessibly", () => {
    const html = segmentedMarkup([{ value: "demo", label: "ДЕМО" }, { value: "live", label: "LIVE" }], "live");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("LIVE");
  });

  it("escapes all user-facing component text", () => {
    expect(islandMarkup("<span>trusted</span>")).toContain("<span>trusted</span>");
    expect(emptyStateMarkup({ title: "<script>", description: "safe" })).not.toContain("<script>");
    expect(buttonMarkup({ label: "<x>", variant: "unknown" })).toContain("&lt;x&gt;");
  });
  it("tokenizes multiple island classes and escapes each class", () => {
    const html = islandMarkup("content", { className: "alpha beta <unsafe>" });
    expect(html).toContain('class="kg-island alpha beta &lt;unsafe&gt;"');
  });

  it("keeps disabled action rows semantic and non-interactive", () => {
    const html = listRowMarkup({ title: "LIVE", action: "live", disabled: true });
    expect(html).toContain("<button");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-disabled="true"');
  });

  it("renders settings rows with escaped labels and values", () => {
    const html = settingsRowMarkup({ title: "<Account>", value: "—", icon: "A", iconColor: "#3e86f0", action: "settings" });
    expect(html).toContain("&lt;Account&gt;");
    expect(html).toContain("--kg-settings-icon-color:#3e86f0");
  });

  it("renders a fixed-size sparkline or an honest empty value", () => {
    expect(sparklineMarkup([1, 2, 3])).toContain('width="56" height="24"');
    expect(sparklineMarkup([])).toContain("—");
  });

  it("does not invent heatmap change or volume when data is missing", () => {
    const html = heatmapTileMarkup({ symbol: "BTC" });
    expect(html).toContain("<span>—</span>");
    expect(html).toContain("<small>—</small>");
    expect(html).toContain('data-volume=""');
  });

  it("marks hidden bottom sheets and current navigation tab accessibly", () => {
    expect(bottomSheetMarkup("<p>trusted</p>", { title: "Форма" })).toContain(" hidden");
    const nav = floatingTabBarMarkup([{ value: "wallet", label: "Кошелёк", icon: "◉" }], "wallet");
    expect(nav).toContain('aria-current="page"');
  });

  it("escapes feedback text and only renders retry action when supplied", () => {
    expect(toastMarkup("<bad>")).toContain("&lt;bad&gt;");
    expect(errorBannerMarkup("Ошибка <x>", { action: "retry" })).toContain('data-action="retry"');
    expect(errorBannerMarkup("Ошибка")).not.toContain("<button");
  });

});
