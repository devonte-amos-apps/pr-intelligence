// Renders the sticky PR intelligence comment from evaluateGate results and review data.
// Threshold prose comes from GATE_POLICY in gate.mjs so the matrix cannot drift from the checks.

import { GATE_POLICY, findingList } from "./gate-policy.mjs";
import { areaStatus, findingSeverityLabel, firstParagraph, proseCell, tableCell, trustedCell } from "./markdown.mjs";

export const MISSING_RULES_NOTICE = "No architecture rules file found — PR-focused review only";

export function formatPrSummary(review, metadata = {}) {
  const title = metadata.title || "";
  const number = metadata.number ? String(metadata.number) : "";
  const url = metadata.url || "";
  const modelSummary = review?.summary || "";
  const titleText = title || (number ? `PR #${number}` : "");
  const linked = url && titleText ? `[${tableCell(titleText, 160)}](${url})` : tableCell(titleText, 160);
  const heading = number && titleText && !titleText.includes(`#${number}`)
    ? `${linked} (#${number})`
    : linked;
  const parts = [];
  if (titleText) parts.push(heading);
  if (modelSummary) parts.push(tableCell(modelSummary, 320));
  let summary = parts.filter(Boolean).join(": ") || "No summary was provided.";
  const excerpt = firstParagraph(metadata.body || "", 180);
  if (excerpt && excerpt !== tableCell(modelSummary, 180) && !summary.includes(excerpt)) {
    summary += ` — ${excerpt}`;
  }
  return summary;
}

function policyFlags(result = {}) {
  return {
    failOnHigh: result.failOnHigh !== false,
    failOnMajors: result.failOnMajors !== false,
    failOnHighFindings: result.failOnHighFindings !== false,
    failOnAreaFail: result.failOnAreaFail !== false,
    allowMajorUpgrade: result.allowMajorUpgrade === true,
  };
}

export function buildCheckRows(result) {
  const policy = GATE_POLICY.checks;
  const flags = policyFlags(result);
  const failOnHigh = flags.failOnHigh;
  const failOnMajors = flags.failOnMajors;
  const failed = new Set((result.failures || []).map((f) => f.check));
  const triggerOf = (check) => (typeof check.trigger === "function" ? check.trigger(flags) : check.trigger);

  const audit = result.audit || {};
  const auditOutcome = !audit.parsed
    ? "not readable"
    : `${failed.has("npm audit") ? "Fail" : "Pass"} (${audit.critical} critical, ${audit.high} high, ${audit.moderate} moderate, ${audit.low} low)`;

  const cruiserRequested = Boolean(result.cruiserRequested);
  const cruiser = result.cruiser;
  const cruiserDetails = result.cruiserDetails;
  let cruiserOutcome = "not run or count unavailable";
  if (!cruiserRequested) cruiserOutcome = "not requested";
  else if (cruiserDetails?.skipped) cruiserOutcome = "skipped (not installed)";
  else if (failed.has("dependency-cruiser") && cruiser?.modules === 0) cruiserOutcome = "Fail (0 modules checked)";
  else if (failed.has("dependency-cruiser") && cruiserDetails?.errors > 0) {
    cruiserOutcome = `Fail (${cruiser.modules} modules, ${cruiser.dependencies} dependencies checked; ${cruiserDetails.errors} cruiser error(s))`;
  } else if (failed.has("dependency-cruiser")) cruiserOutcome = "Fail";
  else if (cruiser) {
    cruiserOutcome = `Pass (${cruiser.modules} modules, ${cruiser.dependencies} dependencies checked)`;
  }

  const introduced = result.introduced || [];
  let majorsOutcome = `Pass (${introduced.length})`;
  if (failed.has("Majors introduced") || failed.has("Major upgrades")) {
    const list = introduced.map((m) => `${m.name} ${m.from} → ${m.to}`).join(", ");
    majorsOutcome = `Fail (${introduced.length}${list ? `: ${list}` : ""})`;
  } else if (introduced.length && flags.allowMajorUpgrade) {
    majorsOutcome = `Pass (${introduced.length}; allowed by allow-major-upgrade)`;
  } else if (introduced.length && !failOnMajors) {
    majorsOutcome = `Pass (${introduced.length}; warning — fail-on-majors is off)`;
  }

  const risk = result.risk;
  let riskOutcome = "unavailable (skipped)";
  if (risk) {
    if (failed.has("Review risk")) riskOutcome = `Fail (${risk.toUpperCase()})`;
    else if ((risk === "high" || risk === "critical") && !failOnHigh) {
      riskOutcome = `Pass (${risk.toUpperCase()}; fail-on-high is off)`;
    } else riskOutcome = `Pass (${risk.toUpperCase()})`;
  }

  const review = result.review;
  const listed = findingList(review);
  let findingsOutcome = "unavailable";
  if (review && !review.unavailable) {
    const detail = listed.length
      ? `${listed.length} finding${listed.length === 1 ? "" : "s"} (${listed.join(", ")})`
      : "0 findings";
    findingsOutcome = `${failed.has("Architecture findings") ? "Fail" : "Pass"} (${detail})`;
  }

  const failingAreas = Array.isArray(review?.areas) ? review.areas.filter((area) => area.status === "fail") : [];
  let areasOutcome = "unavailable";
  if (review && !review.unavailable) {
    areasOutcome = failed.has("Areas")
      ? `Fail (${failingAreas.map((area) => area.area).join(", ") || "area Fail"})`
      : "Pass (no failed areas)";
  }

  return [
    { check: policy.audit.name, type: policy.audit.type, outcome: auditOutcome, trigger: triggerOf(policy.audit) },
    { check: policy.cruiser.name, type: policy.cruiser.type, outcome: cruiserOutcome, trigger: triggerOf(policy.cruiser) },
    { check: policy.majors.name, type: policy.majors.type, outcome: majorsOutcome, trigger: triggerOf(policy.majors) },
    { check: policy.risk.name, type: policy.risk.type, outcome: riskOutcome, trigger: triggerOf(policy.risk) },
    { check: policy.findings.name, type: policy.findings.type, outcome: findingsOutcome, trigger: triggerOf(policy.findings) },
    { check: policy.areas.name, type: policy.areas.type, outcome: areasOutcome, trigger: triggerOf(policy.areas) },
  ];
}

export function renderThresholdMatrix(result = {}) {
  const flags = policyFlags(result);
  const lines = [
    "<details>",
    "<summary>What outcomes can fail the intelligence review?</summary>",
    "",
    "Thresholds below are generated from the gate policy in code (the same rules `evaluateGate` applies). They describe current behaviour, not a proposed ruleset.",
    "",
  ];
  for (const [category, meta] of Object.entries(GATE_POLICY.categories)) {
    lines.push(`#### ${meta.title}`, "", `${meta.intro}`, "");
    for (const check of Object.values(GATE_POLICY.checks)) {
      if (check.category !== category) continue;
      const trigger = typeof check.trigger === "function"
        ? check.matrixTrigger || check.trigger(flags)
        : check.trigger;
      lines.push(`- **${check.name}** (${check.type}): ${trigger}`);
    }
    lines.push("");
  }
  lines.push("</details>", "");
  return lines.join("\n");
}

export function renderReviewBreakdown(review, metadata = {}, options = {}) {
  const lines = ["## PR review breakdown", ""];
  if (review && review.rulesFound === false) {
    lines.push(`> ${review.rulesNotice || MISSING_RULES_NOTICE}`, "");
  }

  lines.push("### Risk", "", "| Risk | PR Summary |", "| --- | --- |");
  if (!review || review.unavailable) {
    const risk = "unavailable";
    const summary = review?.reason
      ? `${tableCell(review.reason, 240)}${review.recovery ? ` ${tableCell(review.recovery, 200)}` : ""}`
      : "The architecture review was not available, so there is no structured summary.";
    lines.push(`| ${tableCell(risk, 24)} | ${summary} |`, "");
  } else {
    const risk = review.risk ? String(review.risk).toUpperCase() : "unavailable";
    lines.push(`| ${tableCell(risk, 16)} | ${formatPrSummary(review, metadata)} |`, "");
  }

  lines.push("### Findings", "", "| Severity | Rule | Evidence | Impact & Action |", "| --- | --- | --- | --- |");
  const findings = Array.isArray(review?.findings) ? review.findings.slice(0, 5) : [];
  if (findings.length) {
    for (const finding of findings) {
      const evidence = Array.isArray(finding.evidence) ? finding.evidence.join(", ") : (finding.evidence || "Not supplied");
      const action = [finding.impact, finding.recommendation ? `Action: ${finding.recommendation}` : ""].filter(Boolean).join(" ");
      lines.push(`| ${tableCell(findingSeverityLabel(finding.severity, options), 28)} | ${tableCell(finding.ruleId || "—", 24)} | ${tableCell(evidence, 140)} | ${tableCell(action, 240)} |`);
    }
  } else {
    lines.push("| — | — | — | No material findings. |");
  }
  lines.push("");

  lines.push("### Areas", "", "| Area | Status | Evidence |", "| --- | --- | --- |");
  const areas = Array.isArray(review?.areas) ? review.areas.slice(0, 6) : [];
  if (areas.length) {
    for (const area of areas) {
      lines.push(`| ${tableCell(area.area, 60)} | ${areaStatus(area.status, options)} | ${tableCell(area.evidence, 180)} |`);
    }
  } else {
    lines.push("| Overall review | ➖ N/A | No areas were returned. |");
  }
  lines.push("");

  const notes = Array.isArray(review?.architectureNotes)
    ? review.architectureNotes.filter((note) => typeof note === "string" && note.trim()).slice(0, 5)
    : [];
  if (notes.length) {
    lines.push("### Architecture notes", "");
    for (const note of notes) lines.push(`- ${tableCell(note, 240)}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function renderDependenciesAndFollowUps(review, upgradeTable = "") {
  if (!review || review.unavailable) return upgradeTable ? `${upgradeTable}\n` : "";
  const lines = [];
  const dependencies = Array.isArray(review.dependencies) ? review.dependencies.slice(0, 5) : [];
  lines.push("### Dependency and security findings", "", "| Severity | Package | Issue | Recommendation |", "| --- | --- | --- | --- |");
  if (dependencies.length) {
    for (const dependency of dependencies) {
      lines.push(`| ${tableCell(dependency.severity, 12)} | ${tableCell(dependency.package, 40)} | ${tableCell(dependency.issue, 180)} | ${tableCell(dependency.recommendation, 180)} |`);
    }
  } else {
    lines.push("| — | — | No material dependency findings. | — |");
  }
  lines.push("");
  if (upgradeTable) lines.push(upgradeTable, "");
  const followUps = Array.isArray(review.followUps) ? review.followUps.slice(0, 3) : [];
  lines.push("### Follow-ups", "");
  if (followUps.length) {
    for (const item of followUps) lines.push(`- [ ] ${tableCell(item, 180)}`);
  } else {
    lines.push("- [x] No additional follow-up requested.");
  }
  lines.push("");
  return lines.join("\n");
}

export function renderGateLead(review) {
  const lines = [];
  const logic = review && !review.unavailable && typeof review.summary === "string"
    ? review.summary.trim()
    : "";
  if (logic) lines.push("### Summary", "", proseCell(logic, 500), "");
  const changes = review?.changes;
  const hasChanges = changes && typeof changes === "object"
    && (changes.added || changes.refactored || changes.removed);
  if (hasChanges) {
    const item = (label, value) => `- **${label}:** ${proseCell(value || "None", 500)}`;
    lines.push("### What this PR changes", "");
    lines.push(item("Added", changes.added), item("Refactored", changes.refactored), item("Removed", changes.removed), "");
  }
  return lines;
}

export function renderGateComment(result, { metadata, upgradeTable } = {}) {
  const review = result.review;
  const meta = metadata || review?.metadata || {};
  const lines = [`## PR intelligence gate: ${result.passed ? "✅ passed" : "❌ failed"}`, ""];
  lines.push(...renderGateLead(review));
  lines.push("| Check | Type | Outcome | Failure Trigger |", "| --- | --- | --- | --- |");
  for (const row of buildCheckRows(result)) {
    lines.push(`| ${trustedCell(row.check)} | ${trustedCell(row.type)} | ${tableCell(row.outcome, 220)} | ${trustedCell(row.trigger)} |`);
  }
  lines.push("");

  if (result.failures?.length) {
    lines.push("### Why it failed", "");
    for (const f of result.failures) {
      lines.push(`- **${f.check}:** ${f.reason}`, `  - How to fix: ${f.fix}`);
    }
    lines.push("");
  }
  if (result.warnings?.length) {
    lines.push("### Warnings", "");
    for (const w of result.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  lines.push(renderReviewBreakdown(review, meta, policyFlags(result)));
  lines.push(renderDependenciesAndFollowUps(review, upgradeTable));

  const release = result.releaseSuggestion;
  if (release?.level) {
    lines.push("### Release suggestion", "", `**${release.level}** — ${release.reason}`, "");
  }
  if (result.severityStatus?.summary) {
    const label = result.severityStatus.clear ? "Clear" : result.severityStatus.summary;
    lines.push("### Severity status", "", result.severityStatus.clear
      ? "**Clear** — no high or critical blocking items remain."
      : `**${label}**`, "");
  }

  if (result.availableMajors?.length) {
    lines.push("### Major upgrades available (warning only)", "");
    for (const m of result.availableMajors) lines.push(`- \`${m.name}\` ${m.current} → ${m.latest}`);
    lines.push("", "Upgrade majors in dedicated PRs.", "");
  }

  lines.push(renderThresholdMatrix(result));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}
