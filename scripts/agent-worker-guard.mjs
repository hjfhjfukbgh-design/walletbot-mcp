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
