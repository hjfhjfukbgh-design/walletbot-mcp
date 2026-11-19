export function extractScopeItems(task) {
  const text = String(task || "");
  const match = text.match(/##\s*(?:Scope|Области|Область|Проверки|Checks|Объём|Объем)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  const scopeText = match?.[1] || "";
  const bulletItems = scopeText
    .split(/\r?\n/)
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, "").trim());
  return (bulletItems.length ? bulletItems : scopeText.split(/[;\n]+/).map(item => item.trim()).filter(Boolean)).slice(0, 15);
}

export function normalizeAnalysisReport(input) {
  let report = String(input || "");
  const hasUnverifiedEvidence = /NOT VERIFIED|NOT RUN|НЕ ПРОВЕРЕНО|НЕ ЗАПУСКАЛ/i.test(report);
  const lines = report.split(/\r?\n/);
  const headingIndex = lines.findIndex(line =>
    /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Общий\s+)?Вердикт(?=\s|[:：]|$|\*)/i.test(line)
  );

  let valueIndex = -1;
  let verdictValue = "";
  if (headingIndex >= 0) {
    const heading = lines[headingIndex];
    const inline = heading.match(/^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Общий\s+)?Вердикт(?:\*\*)?\s*[:：]\s*(.*)$/i);
    if (inline) {
      valueIndex = headingIndex;
      verdictValue = inline[1];
    } else {
      for (let index = headingIndex + 1; index < lines.length; index++) {
        if (lines[index].trim()) {
          valueIndex = index;
          verdictValue = lines[index];
          break;
        }
      }
    }
  }

  const optimisticPattern = /\b(PASS|ACCEPTED|ОДОБРЕНО|ПРИНЯТО)\b/i;
  if (hasUnverifiedEvidence && valueIndex >= 0 && optimisticPattern.test(verdictValue)) {
    lines[valueIndex] = lines[valueIndex].replace(optimisticPattern, "PARTIAL — есть непроверенные пункты");
    report = lines.join("\n");
    verdictValue = lines[valueIndex];
  } else if (hasUnverifiedEvidence && (headingIndex < 0 || valueIndex < 0)) {
    report += "\n\nВердикт: PARTIAL — обязательные проверки не завершены; пункты NOT VERIFIED не считаются пройденными.";
    verdictValue = "PARTIAL";
  }

  return {
    report,
    hasUnverifiedEvidence,
    optimisticVerdict: hasUnverifiedEvidence && optimisticPattern.test(verdictValue),
  };
}

export function findMissingScopeRows(report, scopeItems) {
  return scopeItems
    .map((_, index) => "S" + (index + 1))
    .filter(id => !new RegExp("\\|\\s*(?:\\*\\*)?\\[" + id + "\\](?:\\*\\*)?\\s*\\|").test(String(report || "")));
}

export function findUnverifiedReferences(report, selectedPaths, sourceText) {
  const available = new Set(selectedPaths || []);
  const source = String(sourceText || "");
  const warnings = new Set();

  const pathPattern = /(?:`|\\b)((?:miniapp|src|test|tests)\\/[A-Za-z0-9_./-]+)(?:`|\\b)/g;
  for (const match of String(report || "").matchAll(pathPattern)) {
    const path = match[1].replace(/[),.;:]+$/, "");
    if (!available.has(path)) warnings.add("Путь не входит в фактически прочитанный контекст: " + path);
  }

  const selectorPattern = /`(#[A-Za-z][A-Za-z0-9_-]*|\\[data-[A-Za-z0-9_-]+(?:=(?:"[^"]*"|'[^']*'))?\\])`/g;
  for (const match of String(report || "").matchAll(selectorPattern)) {
    if (!source.includes(match[1])) warnings.add("UI selector не найден в переданных исходниках: " + match[1]);
  }

  const endpointPattern = /\\b(GET|POST|PUT|PATCH|DELETE)\\s+`?(\\/api\\/[A-Za-z0-9_/?{}.-]+)`?/gi;
  for (const match of String(report || "").matchAll(endpointPattern)) {
    const method = match[1].toUpperCase();
    const path = match[2];
    const route = method + " " + path.replace(/^\\/api\\//, "");
    if (!source.includes(route) && !source.includes(path))
      warnings.add("Backend route не найден в переданных исходниках: " + method + " " + path);
  }

  return [...warnings];
}
