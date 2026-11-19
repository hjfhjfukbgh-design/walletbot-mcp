import { describe, expect, it } from "vitest";
import { contextLimit, extractScopeItems, findMissingScopeRows, findUnverifiedReferences, normalizeAnalysisReport } from "../scripts/agent-worker-guard.mjs";

describe("agent worker evidence guard", () => {
  it("extracts semicolon-separated Russian scope items", () => {
    const items = extractScopeItems("## Области\nКошелёк; DEMO/LIVE/ИИ; рынок и поиск; AI Companion\n\n## Правила\nNo writes");
    expect(items).toEqual(["Кошелёк", "DEMO/LIVE/ИИ", "рынок и поиск", "AI Companion"]);
  });

  it("extracts QA checks from the Russian Проверки heading", () => {
    const items = extractScopeItems("## Проверки\nРазмеры 360/375/390/430 px; светлая и тёмная тема; safe-area; Telegram BackButton\n\n## Выход\nReport");
    expect(items).toEqual(["Размеры 360/375/390/430 px", "светлая и тёмная тема", "safe-area", "Telegram BackButton"]);
  });

  it("downgrades only the explicit verdict, not PASS words in evidence rows", () => {
    const input = "### Вердикт\n**PASS**\n\n| [S1] | NOT VERIFIED | no screenshot |";
    const result = normalizeAnalysisReport(input);
    expect(result.report).toContain("**PARTIAL — есть непроверенные пункты**");
    expect(result.optimisticVerdict).toBe(false);
  });

  it("does not treat PASS in the table as an optimistic verdict after PARTIAL", () => {
    const input = "Вердикт: PARTIAL — incomplete\n\n| [S1] | PASS | static check |\n| [S2] | NOT VERIFIED | device test |";
    const result = normalizeAnalysisReport(input);
    expect(result.report).toBe(input);
    expect(result.optimisticVerdict).toBe(false);
  });

  it("downgrades an inline ACCEPTED verdict when evidence is unverified", () => {
    const result = normalizeAnalysisReport("Вердикт: ACCEPTED\n\nS1: NOT VERIFIED");
    expect(result.report).toContain("Вердикт: PARTIAL — есть непроверенные пункты");
    expect(result.optimisticVerdict).toBe(false);
  });

  it("adds a PARTIAL verdict when unverified evidence has no verdict heading", () => {
    const result = normalizeAnalysisReport("S1: NOT VERIFIED");
    expect(result.report).toContain("Вердикт: PARTIAL");
  });

  it("recognizes bold scope IDs and reports missing rows", () => {
    expect(findMissingScopeRows("| **[S1]** | PASS | proof |\n| [S3] | NOT VERIFIED | none |", ["one", "two", "three"])).toEqual(["S2"]);
  });
});

it("flags paths, selectors and API routes that are absent from inspected source", () => {
  const report = "`miniapp/endpoints/contracts` `#position-close` `POST /api/companion/chat`";
  const warnings = findUnverifiedReferences(report, ["miniapp/web/index.html", "src/api.ts"], '$("#kg-wallet-ai") case "GET contracts"');
  expect(warnings).toHaveLength(3);
});

it("accepts paths, selectors and API routes present in inspected source", () => {
  const report = "`miniapp/web/index.html` `#kg-wallet-ai` `GET /api/contracts`";
  const warnings = findUnverifiedReferences(report, ["miniapp/web/index.html", "src/api.ts"], '$("#kg-wallet-ai") case "GET contracts"');
  expect(warnings).toEqual([]);
});

it("accepts CSS selectors represented by HTML id and data attributes", () => {
  const tick = String.fromCharCode(96);
  const report = tick + "#kg-wallet-ai" + tick + " " + tick + "[data-wallet-action=\"transfer\"]" + tick;
  const source = '<button id="kg-wallet-ai" data-wallet-action="transfer"></button>';
  expect(findUnverifiedReferences(report, ["miniapp/web/index.html"], source)).toEqual([]);
});

it("retains a 30-action audit checklist instead of truncating at 15", () => {
  const actions = Array.from({ length: 30 }, (_, index) => "action " + (index + 1)).join("; ");
  expect(extractScopeItems("## Области\n" + actions + "\n\n## Правила\nread only")).toHaveLength(30);
});

it("loads full UI controller and explicit audit files into context", () => {
  expect(contextLimit("miniapp/web/kripto-guru-ui.js", ["miniapp/web/kripto-guru-ui.js"])).toBe(100000);
  expect(contextLimit("miniapp/web/index.html", ["miniapp/web/index.html"])).toBe(50000);
  expect(contextLimit("src/companion.ts", ["src/companion.ts"])).toBe(50000);
  expect(contextLimit("README.md", [])).toBe(9000);
});
