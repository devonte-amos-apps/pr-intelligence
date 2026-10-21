// PR intelligence gate: deterministic pass/fail over collected diagnostics.
// Pure helpers are exported for unit tests.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { directDependencies, parseOutdated, buildUpgradeSuggestions } from "./dependency-upgrades.mjs";

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

export function evaluateGate({ auditText, riskText, cruiserText, cruiserExit, cruiserRequested, basePackage, headPackage, outdatedText, failOnHigh = true, failOnMajors = false }) {
  const failures = [];
  const warnings = [];
  const audit = auditCounts(auditText);
  const risk = parseRisk(riskText);
  const cruiser = parseCruiserModules(cruiserText);

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
    failures.push({
      check: "Review risk",
      reason: `The architecture review rated this PR ${risk.toUpperCase()} risk.`,
      fix: "Address the findings in the PR Architecture Intelligence comment, push, and let the review rerun.",
    });
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

  return { passed: failures.length === 0, failures, warnings, audit, risk, cruiser, introduced, availableMajors: available };
}

export function renderGateSummary(result) {
  const lines = [`## PR intelligence gate: ${result.passed ? "✅ passed" : "❌ failed"}`, ""];
  const a = result.audit;
  lines.push("| Check | Result |", "| --- | --- |");
  lines.push(`| npm audit | ${a.parsed ? `${a.critical} critical, ${a.high} high, ${a.moderate} moderate, ${a.low} low` : "not readable"} |`);
  lines.push(`| Review risk | ${result.risk ? result.risk.toUpperCase() : "unavailable (skipped)"} |`);
  lines.push(`| dependency-cruiser | ${result.cruiser ? `${result.cruiser.modules} modules, ${result.cruiser.dependencies} dependencies checked` : "not run or count unavailable"} |`);
  lines.push(`| Majors introduced by this PR | ${result.introduced.length} |`, "");
  if (result.failures.length) {
    lines.push("### Why it failed", "");
    for (const f of result.failures) lines.push(`- **${f.check}:** ${f.reason}`, `  - How to fix: ${f.fix}`);
    lines.push("");
  }
  if (result.warnings.length) {
    lines.push("### Warnings", "");
    for (const w of result.warnings) lines.push(`- ${w}`);
    lines.push("");
  }
  if (result.availableMajors.length) {
    lines.push("### Major upgrades available (warning only)", "");
    for (const m of result.availableMajors) lines.push(`- \`${m.name}\` ${m.current} → ${m.latest}`);
    lines.push("", "Upgrade majors in dedicated PRs.", "");
  }
  return lines.join("\n");
}

async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
}

export async function runGate({ cwd = process.cwd(), env = process.env } = {}) {
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
  process.stdout.write(`${summary}\n`);
  for (const f of result.failures) process.stderr.write(`::error title=PR intelligence gate (${f.check})::${f.reason} ${f.fix}\n`.replace(/\n(?!$)/g, " "));
  if (!result.passed) process.exitCode = 1;
  return result;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntryPoint) await runGate();
