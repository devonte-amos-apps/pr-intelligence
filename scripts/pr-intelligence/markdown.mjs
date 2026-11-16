// Shared comment escaping and table helpers for gate and architecture review comments.
export function redactSecretValues(value, apiKey = process.env.GEMINI_API_KEY) {
  let result = String(value ?? "");
  if (apiKey) result = result.replaceAll(apiKey, "[redacted Gemini API key]");
  return result.replace(/\bAIza[A-Za-z0-9_-]{20,}/g, "[redacted Gemini API key]");
}

export function redactSecrets(value, apiKey = process.env.GEMINI_API_KEY) {
  return redactSecretValues(value == null || value === "" ? "Unknown error" : value, apiKey);
}

export function compactText(value, maxCharacters = 240) {
  const compact = redactSecretValues(value)
    .replaceAll("@", "@\u200b")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();
  return compact.length <= maxCharacters
    ? compact
    : `${compact.slice(0, maxCharacters - 1).trimEnd()}…`;
}

export function tableCell(value, maxCharacters) {
  return compactText(value, maxCharacters).replaceAll("|", "\\|");
}

export function areaStatus(status, { failOnAreaFail = true } = {}) {
  if (status === "fail" && failOnAreaFail !== false) return "❌ Fail (blocks gate)";
  return {
    pass: "✅ Pass",
    warn: "⚠️ Warn",
    fail: "❌ Fail",
    not_applicable: "➖ N/A",
  }[status] || "➖ Unknown";
}

/** High/critical findings block the gate unless fail-on-high-findings is off. */
export function findingSeverityLabel(severity, { failOnHighFindings = true } = {}) {
  const level = String(severity || "").toLowerCase() || "unknown";
  const blocks = failOnHighFindings !== false && (level === "high" || level === "critical");
  return `${level} (${blocks ? "blocks gate" : "advisory"})`;
}

export function firstParagraph(text, maxCharacters = 200) {
  const stripped = String(text || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/^#+\s+/gm, "")
    .replace(/\r/g, "")
    .trim();
  if (!stripped) return "";
  const paragraph = stripped.split(/\n\s*\n/)[0] || "";
  return compactText(paragraph, maxCharacters);
}

/** For policy/check labels we control: keep >, < and @ so threshold text stays exact. */
export function trustedCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}
