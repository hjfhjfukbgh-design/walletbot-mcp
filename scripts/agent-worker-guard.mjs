export function extractScopeItems(task) {
  const text = String(task || "");
  const match = text.match(/##\s*(?:Scope|Области|Область|Проверки|Проверить|Checks|Объём|Объем)[^\n]*\n([\s\S]*?)(?=\n##\s|$)/i);
  const scopeText = match?.[1] || "";
  const bulletItems = scopeText
    .split(/\r?\n/)
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => line.replace(/^\s*[-*]\s+/, "").trim());
  return (bulletItems.length ? bulletItems : scopeText.split(/[;\n]+/).map(item => item.trim()).filter(Boolean)).slice(0, 40);
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

  const pathPattern = /\b((?:miniapp|src|test|tests)\/[A-Za-z0-9_./-]+)\b/g;
  for (const match of String(report || "").matchAll(pathPattern)) {
    const path = match[1].replace(/[),.;:]+$/, "");
    if (!available.has(path)) warnings.add("Путь не входит в фактически прочитанный контекст: " + path);
  }

  const selectorPattern = /(#[A-Za-z][A-Za-z0-9_-]*|\[data-[A-Za-z0-9_-]+(?:="[^"]*"|'[^']*')?\])/g;
  for (const match of String(report || "").matchAll(selectorPattern)) {
    const selector = match[1];
    let present = source.includes(selector);
    if (!present && selector.startsWith("#")) {
      const id = selector.slice(1);
      present = source.includes('id="' + id + '"') || source.includes("id='" + id + "'");
    }
    if (!present && selector.startsWith("[data-")) {
      const attribute = selector.slice(1, -1).split("=")[0];
      const value = selector.match(/=["']([^"']+)["']/)?.[1];
      present = value
        ? source.includes(attribute + '="' + value + '"') || source.includes(attribute + "='" + value + "'")
        : source.includes(attribute);
    }
    if (!present) warnings.add("UI selector не найден в переданных исходниках: " + selector);
  }

  const endpointPattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/[A-Za-z0-9_/?{}.-]+)/gi;
  for (const match of String(report || "").matchAll(endpointPattern)) {
    const method = match[1].toUpperCase();
    const path = match[2];
    const route = method + " " + path.replace(/^\/api\//, "");
    if (!source.includes(route) && !source.includes(path))
      warnings.add("Backend route не найден в переданных исходниках: " + method + " " + path);
  }

  const citationPattern = /\b((?:miniapp|src|test|tests)\/[A-Za-z0-9_./-]+):L(\d+)(?:-L?(\d+))?\b/g;
  for (const match of String(report || "").matchAll(citationPattern)) {
    const path = match[1];
    const firstLine = Number(match[2]);
    const lastLine = Number(match[3] || match[2]);
    if (!available.has(path)) {
      warnings.add("Диапазон строк ссылается на файл вне прочитанного контекста: " + path);
      continue;
    }
    if (!Number.isSafeInteger(firstLine) || !Number.isSafeInteger(lastLine) || firstLine < 1 || lastLine < firstLine) {
      warnings.add("Некорректный диапазон строк: " + path + ":L" + firstLine + "-L" + lastLine);
    }
  }

  // A PASS row must cite an exact, inspected line range in its evidence cell.
  // Merely naming a file is not proof that the claimed behavior exists.
  for (const line of String(report || "").split(/\r?\n/)) {
    if (!/^\s*\|/.test(line) || !/\[S\d+\]/.test(line)) continue;
    const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
    const statusIndex = cells.findIndex(cell => /^\*{0,2}PASS\*{0,2}$/i.test(cell));
    if (statusIndex < 0) continue;
    const scopeId = cells.find(cell => /^\*{0,2}\[S\d+\]\*{0,2}$/.test(cell)) || "scope row";
    const evidence = cells[statusIndex - 1] || "";
    if (!citationPattern.test(evidence)) {
      warnings.add("Строка " + scopeId + " помечена PASS без точной ссылки file:Lx-Ly в ячейке доказательства.");
    }
    citationPattern.lastIndex = 0;
  }

  return [...warnings];
}

export function contextLimit(path, explicitPaths = []) {
  if (path.endsWith("kripto-guru-ui.js")) return 100000;
  if (path.endsWith("index.html")) return 50000;
  if (explicitPaths.includes(path)) return 50000;
  return 9000;
}
