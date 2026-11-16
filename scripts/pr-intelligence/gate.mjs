// PR intelligence gate: deterministic pass/fail over collected diagnostics.
// Pure helpers are exported for unit tests.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { renderGateComment } from "./comment-layout.mjs";
import { directDependencies, parseOutdated, buildUpgradeSuggestions } from "./dependency-upgrades.mjs";
import { riskFailureCopy } from "./gate-policy.mjs";

export { GATE_POLICY } from "./gate-policy.mjs";

export function auditCounts(text) {
  const empty = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  let data;
  try {
    data = JSON.parse(text || "");
  } catch {
    return { ...empty, parsed: false, packages: [] };
  }
  const meta = data?.metadata?.vulnerabilities || {};
  const counts = { ...empty };
  for (const key of Object.keys(empty)) counts[key] = Number(meta[key]) || 0;
  const packages = Object.values(data?.vulnerabilities || {})
    .filter((v) => v && (v.severity === "high" || v.severity === "critical"))
    .map((v) => {
      const fix = v.fixAvailable;
      const fixText =
        fix === true ? "fix available (`npm audit fix`)" :
        fix && typeof fix === "object" ? `fix: ${fix.name}@${fix.version}${fix.isSemVerMajor ? " (major)" : ""}` :
        "no fix available";
      return { name: v.name, severity: v.severity, fix: fixText };
    });
  return { ...counts, parsed: Boolean(data?.metadata), packages };
}

export function parseRisk(text) {
  try {
    const risk = JSON.parse(text || "")?.risk;
    return ["low", "medium", "high", "critical"].includes(risk) ? risk : null;
  } catch {
    return null;
  }
}

export function parseCruiserModules(text) {
  // Matches both "✔ no dependency violations found (N modules, M dependencies cruised)"
  // and "x K dependency violations (...). N modules, M dependencies cruised."
  const clean = (text || "").replace(/\u001b\[[0-9;]*m/g, "");
  const match = /(\d+)\s+modules?,\s*(\d+)\s+dependenc(?:y|ies)\s+cruised/i.exec(clean);
  return match ? { modules: Number(match[1]), dependencies: Number(match[2]) } : null;
}

export function parseCruiserReport(text) {
  const clean = (text || "").replace(/\u001b\[[0-9;]*m/g, "");
  const counts = parseCruiserModules(clean);
  const match = /(\d+)\s+dependency violations?\s+\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i.exec(clean);
  return {
    modules: counts?.modules ?? null,
    dependencies: counts?.dependencies ?? null,
    violations: match ? Number(match[1]) : 0,
    errors: match ? Number(match[2]) : 0,
    warnings: match ? Number(match[3]) : 0,
    skipped: /\bskipped\b/i.test(clean),
  };
}

export function parseReview(text) {
  try {
    const data = JSON.parse(text || "");
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

const majorOf = (range) => {
  const m = /^[\s^~>=v]*(\d+)/.exec(String(range || ""));
  return m ? Number(m[1]) : null;
};

/** Majors the PR itself introduces: direct deps whose declared major rose vs base. */
export function introducedMajors(basePackage, headPackage) {
  if (!basePackage || !headPackage) return [];
  const base = directDependencies(basePackage);
  return [...directDependencies(headPackage)]
    .filter(([name, d]) => base.has(name) && majorOf(base.get(name).range) !== null && majorOf(d.range) !== null && majorOf(d.range) > majorOf(base.get(name).range))
    .map(([name, d]) => ({ name, from: base.get(name).range, to: d.range }));
}

export function evaluateGate({ auditText, riskText, cruiserText, cruiserExit, cruiserRequested, basePackage, headPackage, outdatedText, failOnHigh = true, failOnMajors = false, review: reviewInput } = {}) {
  const failures = [];
  const warnings = [];
  const audit = auditCounts(auditText);
  const risk = parseRisk(riskText);
  const cruiser = parseCruiserModules(cruiserText);
  const cruiserDetails = parseCruiserReport(cruiserText);
  const review = reviewInput || parseReview(riskText);

  if (!audit.parsed) warnings.push("npm audit output could not be read, so vulnerabilities were not checked.");
  else if (audit.high + audit.critical > 0) {
    const list = audit.packages.map((p) => `\`${p.name}\` (${p.severity}, ${p.fix})`).join(", ");
    failures.push({
      check: "npm audit",
      reason: `${audit.critical} critical and ${audit.high} high vulnerabilities${list ? `: ${list}` : ""}.`,
      fix: "Run `npm audit` locally, then `npm audit fix` or bump the listed packages to a patched version. Use `overrides` in package.json for transitive packages.",
    });
  }

  if (risk === null) warnings.push("AI risk rating unavailable (Gemini down, rate-limited or not configured); the risk check was skipped.");
  else if (failOnHigh && (risk === "high" || risk === "critical")) {
    const { reason, fix } = riskFailureCopy(risk, review);
    failures.push({ check: "Review risk", reason, fix });
  }

  if (cruiserRequested) {
    if (cruiser === null && /\bskipped\b/i.test(cruiserText || "")) warnings.push("dependency-cruiser was requested but skipped (not installed in this repo).");
    else if (cruiser === null) warnings.push(`dependency-cruiser module count unavailable (exit ${cruiserExit ?? "unknown"}).`);
    else if (cruiser.modules === 0) {
      failures.push({
        check: "dependency-cruiser",
        reason: "dependency-cruiser checked 0 modules, so the import check proves nothing.",
        fix: "Check `dependency-cruiser-dirs` and the cruiser's TypeScript setup (for example, give it its own TypeScript 6 if the project uses TypeScript 7).",
      });
    }
  }

  const introduced = introducedMajors(basePackage, headPackage);
  if (introduced.length) {
    const list = introduced.map((m) => `\`${m.name}\` ${m.from} → ${m.to}`).join(", ");
    if (failOnMajors) {
      failures.push({ check: "Major upgrades", reason: `This PR introduces major version bumps: ${list}.`, fix: "Move each major upgrade into its own PR, or set `fail-on-majors: false`." });
    } else warnings.push(`This PR introduces major version bumps: ${list}.`);
  }

  let available = [];
  try {
    available = headPackage ? buildUpgradeSuggestions(headPackage, parseOutdated(outdatedText || "")).filter((s) => s.kind === "major") : [];
  } catch {
    available = [];
  }

  return { passed: failures.length === 0, failures, warnings, audit, risk, cruiser, cruiserDetails, cruiserRequested: Boolean(cruiserRequested), introduced, availableMajors: available, review, failOnHigh, failOnMajors };
}

export function renderGateSummary(result, options) {
  return renderGateComment(result, options);
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

export async function runGate({ cwd = process.cwd(), env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const dir = path.resolve(cwd, ".pr-architecture");
  const json = (text) => {
    try { return JSON.parse(text); } catch { return null; }
  };
  const result = evaluateGate({
    auditText: await readOptional(path.join(dir, "npm-audit.txt")),
    riskText: await readOptional(path.join(dir, "review-result.json")),
    cruiserText: await readOptional(path.join(dir, "dependency-cruiser.txt")),
    cruiserExit: (await readOptional(path.join(dir, "dependency-cruiser.exit"))).trim() || undefined,
    cruiserRequested: Boolean((env.DEPCRUISE_DIRS || "").trim()),
    basePackage: json(await readOptional(path.join(dir, "base-package.json"))),
    headPackage: json(await readOptional(path.resolve(cwd, "package.json"))),
    outdatedText: await readOptional(path.join(dir, "npm-outdated.txt")),
    failOnHigh: env.FAIL_ON_HIGH !== "false",
    failOnMajors: env.FAIL_ON_MAJORS === "true",
  });
  const summary = renderGateSummary(result);
  await fs.writeFile(path.resolve(cwd, "pr-gate.md"), summary);
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  stdout.write(`${summary}\n`);
  for (const f of result.failures) stderr.write(`::error title=PR intelligence gate (${f.check})::${f.reason} ${f.fix}\n`.replace(/\n(?!$)/g, " "));
  if (!result.passed) process.exitCode = 1;
  return result;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) await runGate();
