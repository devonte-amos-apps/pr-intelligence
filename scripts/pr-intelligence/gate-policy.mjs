// Single source of truth for PR intelligence gate thresholds and comment trigger text.
// evaluateGate implements these rules; the comment matrix renders this object so the two cannot drift.

export const GATE_POLICY = {
  categories: {
    deterministic: {
      title: "Deterministic CI Gates",
      intro: "These checks pass or fail from collected diagnostics, independently of the AI review text.",
    },
    heuristic: {
      title: "Heuristic / AI Review Signals",
      intro: "These signals come from the structured architecture review. Only Review risk can fail the gate, and only when `fail-on-high` is enabled. Architecture findings and area results are advisory and do not independently fail the gate.",
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
      trigger: "Fails when dependency-cruiser was requested and it checked 0 modules. Forbidden edges, cycles and other cruiser errors are shown in the outcome but do not fail this gate.",
    },
    majors: {
      name: "Majors introduced",
      type: "Gate",
      category: "deterministic",
      trigger: ({ failOnMajors } = {}) =>
        failOnMajors
          ? "Fails when this PR introduces a major version bump (`fail-on-majors` is true). There is no PR-label override."
          : "Fails when this PR introduces a major version bump and `fail-on-majors` is true (currently off; majors are warnings). There is no PR-label override.",
      matrixTrigger: "Fails when this PR introduces a major version bump and `fail-on-majors` is true (default: false, majors are warnings). There is no PR-label override such as `allow-major-upgrade`.",
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
      trigger: "Advisory. Individual high or critical findings do not independently fail the gate; only the overall Review risk rating can.",
    },
    areas: {
      name: "Areas",
      type: "RFC / Review",
      category: "heuristic",
      trigger: "Advisory. An area marked fail does not independently fail the gate.",
    },
  },
};

export function findingList(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  return findings.map((f) => `${f.ruleId || "unknown"} ${f.severity || "unknown"}`);
}

export function riskFailureCopy(risk, review) {
  const findings = Array.isArray(review?.findings) ? review.findings : [];
  const elevated = findings.filter((f) => f.severity === "high" || f.severity === "critical");
  const bits = elevated.map((f) => {
    const ev = Array.isArray(f.evidence) ? f.evidence.join(", ") : (f.evidence || "");
    return ev ? `${f.ruleId} (${f.severity}) in ${ev}` : `${f.ruleId} (${f.severity})`;
  });
  let reason = `The architecture review rated this PR ${String(risk).toUpperCase()} risk.`;
  if (bits.length) reason += ` Driven by: ${bits.join("; ")}.`;
  const first = elevated[0];
  const fix = first
    ? `Verify or acknowledge the ${first.ruleId} ${first.severity} finding in the PR review breakdown below, push any updates, and let the review rerun.`
    : "Address the findings in the PR review breakdown below, push, and let the review rerun.";
  return { reason, fix };
}
