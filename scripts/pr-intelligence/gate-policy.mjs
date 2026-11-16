// Single source of truth for PR intelligence gate thresholds and comment trigger text.
// evaluateGate implements these rules; the comment matrix renders this object so the two cannot drift.

export const ALLOW_MAJOR_UPGRADE_LABEL = "allow-major-upgrade";

export const GATE_POLICY = {
  categories: {
    deterministic: {
      title: "Deterministic CI Gates",
      intro: "These checks pass or fail from collected diagnostics, independently of the AI review text.",
    },
    heuristic: {
      title: "Heuristic / AI Review Signals",
      intro: "These signals come from the structured architecture review. Review risk, high or critical findings, and failed areas can fail the gate when their inputs are enabled (defaults are strict).",
    },
  },
  checks: {
    audit: {
      name: "npm audit",
      type: "Gate",
      category: "deterministic",
      trigger: "Fails when critical > 0 or high > 0.",
    },
    cruiser: {
      name: "dependency-cruiser",
      type: "Gate",
      category: "deterministic",
      trigger: "Fails when dependency-cruiser was requested and it checked 0 modules, or when it reported errors > 0 (forbidden edges, cycles, or other rule violations).",
    },
    majors: {
      name: "Majors introduced",
      type: "Gate",
      category: "deterministic",
      trigger: ({ failOnMajors, allowMajorUpgrade } = {}) => {
        if (allowMajorUpgrade) {
          return `Fails when this PR introduces a major version bump, unless the PR has the ${ALLOW_MAJOR_UPGRADE_LABEL} label (present on this PR).`;
        }
        if (failOnMajors !== false) {
          return `Fails when this PR introduces a major version bump (\`fail-on-majors\` is true), unless the PR has the ${ALLOW_MAJOR_UPGRADE_LABEL} label.`;
        }
        return "Majors are warnings because `fail-on-majors` is off. The allow-major-upgrade label is not required.";
      },
      matrixTrigger: `Fails when this PR introduces a major version bump and \`fail-on-majors\` is true (default: true), unless the PR has the \`${ALLOW_MAJOR_UPGRADE_LABEL}\` label. Set \`fail-on-majors: false\` to opt the repository out.`,
    },
    risk: {
      name: "Review risk",
      type: "Gate",
      category: "heuristic",
      trigger: ({ failOnHigh } = {}) =>
        failOnHigh !== false
          ? "Fails when the architecture review rates the PR HIGH or CRITICAL (`fail-on-high` is true)."
          : "Fails when the architecture review rates the PR HIGH or CRITICAL and `fail-on-high` is true (currently off).",
      matrixTrigger: "Fails when the architecture review rates the PR HIGH or CRITICAL and `fail-on-high` is true (default: true). If the rating is unavailable, the risk check is skipped and does not fail the gate.",
    },
    findings: {
      name: "Architecture findings",
      type: "RFC / Review",
      category: "heuristic",
      trigger: ({ failOnHighFindings } = {}) =>
        failOnHighFindings !== false
          ? "Fails when any architecture finding has severity high or critical (`fail-on-high-findings` is true). Medium and low are advisory."
          : "High or critical findings are advisory because `fail-on-high-findings` is off. Medium and low are advisory.",
      matrixTrigger: "Fails when any architecture finding has severity high or critical and `fail-on-high-findings` is true (default: true). Medium and low stay advisory.",
    },
    areas: {
      name: "Areas",
      type: "RFC / Review",
      category: "heuristic",
      trigger: ({ failOnAreaFail } = {}) =>
        failOnAreaFail !== false
          ? "Fails when any review area has status Fail (`fail-on-area-fail` is true)."
          : "Failed areas are advisory because `fail-on-area-fail` is off.",
      matrixTrigger: "Fails when any review area has status Fail and `fail-on-area-fail` is true (default: true).",
    },
  },
};

export function parseLabels(text) {
  if (Array.isArray(text)) return text.map((value) => String(value).trim()).filter(Boolean);
  return String(text || "")
    .split(/[\n,]/)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function hasAllowMajorUpgradeLabel(labels) {
  return parseLabels(labels).includes(ALLOW_MAJOR_UPGRADE_LABEL);
}

export function findingList(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return findings.map((f) => `${f.ruleId || "unknown"} ${f.severity || "unknown"}`);
}

export function elevatedFindings(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return findings.filter((f) => f.severity === "high" || f.severity === "critical");
}

export function failedAreas(review) {
  const areas = Array.isArray(review?.areas) ? review.areas : [];
  return areas.filter((area) => area.status === "fail");
}

export function describeFinding(finding) {
  const ev = Array.isArray(finding.evidence) ? finding.evidence.join(", ") : (finding.evidence || "");
  return ev ? `${finding.ruleId} (${finding.severity}) in ${ev}` : `${finding.ruleId} (${finding.severity})`;
}

export function riskFailureCopy(risk, review) {
  const elevated = elevatedFindings(review);
  const bits = elevated.map(describeFinding);
  let reason = `The architecture review rated this PR ${String(risk).toUpperCase()} risk.`;
  if (bits.length) reason += ` Driven by: ${bits.join("; ")}.`;
  const first = elevated[0];
  const fix = first
    ? `Verify or acknowledge the ${first.ruleId} ${first.severity} finding in the PR review breakdown below, push any updates, and let the review rerun.`
    : "Address the findings in the PR review breakdown below, push, and let the review rerun.";
  return { reason, fix };
}

export function suggestRelease({ title = "", body = "", labels = [], changedFiles = "", headRef = "" } = {}) {
  const labelNames = parseLabels(labels).map((name) => name.toLowerCase());
  const heading = String(title || "");
  const text = `${heading}\n${body || ""}`;
  const conventional = /^\s*(\w+)(?:\([^)]*\))?(!)?:/.exec(heading);
  const type = conventional ? conventional[1].toLowerCase() : "";
  const breakingConvention = Boolean(conventional?.[2]);
  const breakingLabel = labelNames.some((name) => ["breaking", "breaking-change", "semver:major", "major"].includes(name));
  const breakingText = /(?:^|\n)\s*BREAKING[- ]CHANGE:\s*\S/i.test(text);

  if (breakingLabel || breakingConvention || breakingText) {
    return { level: "major", reason: "Breaking-change label, conventional `!`, or a BREAKING CHANGE note." };
  }
  if (labelNames.some((name) => ["semver:minor", "minor"].includes(name)) || type === "feat" || /(?:^|\/)feat(?:ure)?\//i.test(headRef)) {
    return { level: "minor", reason: type === "feat" ? "Conventional title type `feat`." : "Minor release label or feat branch." };
  }
  if (
    labelNames.some((name) => ["semver:patch", "patch"].includes(name)) ||
    ["fix", "perf", "revert", "docs", "chore", "ci", "test", "style", "refactor", "build"].includes(type) ||
    /(?:^|\/)fix\//i.test(headRef)
  ) {
    const why = type ? `Conventional title type \`${type}\`.` : /(?:^|\/)fix\//i.test(headRef) ? "Fix branch name." : "Patch release label.";
    return { level: "patch", reason: why };
  }
  const files = String(changedFiles || "")
    .split(/\n/)
    .map((line) => line.replace(/^[A-Z]\s+/, "").trim())
    .filter(Boolean);
  if (files.length && files.every((file) => /\.(md|txt)$/i.test(file) || file.startsWith("docs/") || file.startsWith(".github/"))) {
    return { level: "patch", reason: "Changes are limited to docs or workflow metadata." };
  }
  return { level: "patch", reason: "No conventional type or release label; defaulting to patch." };
}

export function severityStatus(result) {
  const blockers = [];
  const audit = result.audit || {};
  if (audit.parsed && audit.high + audit.critical > 0) {
    blockers.push(`npm audit (${audit.critical} critical, ${audit.high} high)`);
  }
  if (result.failOnHigh !== false && (result.risk === "high" || result.risk === "critical")) {
    blockers.push(`review risk ${String(result.risk).toUpperCase()}`);
  }
  if (result.failOnHighFindings !== false) {
    const elevated = elevatedFindings(result.review);
    if (elevated.length) blockers.push(elevated.map(describeFinding).join("; "));
  }
  if (!blockers.length) return { clear: true, summary: "Clear" };
  return { clear: false, summary: `Blocked: ${blockers.join("; ")}` };
}

export function renderApprovalComment(result) {
  const release = result.releaseSuggestion?.level || "patch";
  if (result.passed) {
    const severity = result.severityStatus?.clear ? "severity clear" : `severity: ${result.severityStatus?.summary || "unknown"}`;
    return `✅ PR intelligence: approved — ${severity}, release: ${release}`;
  }
  const severity = result.severityStatus?.summary || "unknown";
  return `❌ PR intelligence: not approved — gate failed. Severity: ${severity}. Release suggestion: ${release}.`;
}
