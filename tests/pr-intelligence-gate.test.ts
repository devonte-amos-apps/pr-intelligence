import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  auditCounts,
  evaluateGate,
  GATE_POLICY,
  introducedMajors,
  parseCruiserModules,
  parseCruiserReport,
  parseRisk,
  renderGateSummary,
  runGate,
} from "../scripts/pr-intelligence/gate.mjs"

const audit = (high = 0, critical = 0, vulnerabilities = {}) =>
  JSON.stringify({ vulnerabilities, metadata: { vulnerabilities: { info: 0, low: 1, moderate: 2, high, critical } } })

const base = { auditText: audit(), riskText: '{"risk":"low"}', cruiserRequested: false }

describe("parsers", () => {
  it("reads audit counts and high packages", () => {
    const r = auditCounts(audit(1, 0, {
      tailwindcss: { name: "tailwindcss", severity: "high", fixAvailable: { name: "tailwindcss", version: "4.3.3", isSemVerMajor: false } },
      a: { name: "a", severity: "high", fixAvailable: true },
      b: { name: "b", severity: "critical", fixAvailable: false },
      c: { name: "c", severity: "low" },
    }))
    expect(r).toMatchObject({ high: 1, critical: 0, parsed: true })
    expect(r.packages.map((p) => p.fix)).toEqual(["fix: tailwindcss@4.3.3", "fix available (`npm audit fix`)", "no fix available"])
    expect(auditCounts("not json").parsed).toBe(false)
    expect(auditCounts("{}").parsed).toBe(false)
  })
  it("reads risk", () => {
    expect(parseRisk('{"risk":"high"}')).toBe("high")
    expect(parseRisk('{"risk":"nope"}')).toBeNull()
    expect(parseRisk("")).toBeNull()
  })
  it("reads cruiser module counts", () => {
    expect(parseCruiserModules("✔ no dependency violations found (44 modules, 120 dependencies cruised)")).toEqual({ modules: 44, dependencies: 120 })
    expect(parseCruiserModules("x (0 modules, 0 dependencies cruised)")?.modules).toBe(0)
    expect(parseCruiserModules("skipped")).toBeNull()
  })
  it("reads cruiser counts from violation output", () => {
    const out = "  info no-orphans: lib/seo.ts\n\nx 22 dependency violations (2 errors, 0 warnings). 329 modules, 720 dependencies cruised.\n"
    expect(parseCruiserModules(out)).toEqual({ modules: 329, dependencies: 720 })
    expect(parseCruiserModules("\u001b[31mx 1 dependency violations (1 errors, 0 warnings). 1 modules, 1 dependencies cruised.\u001b[39m")).toEqual({ modules: 1, dependencies: 1 })
  })
  it("reads cruiser counts from captured apisandbox output", async () => {
    const text = await fs.readFile(path.join(__dirname, "fixtures-apisandbox-depcruise-violations.txt"), "utf8")
    expect(parseCruiserModules(text)).toEqual({ modules: 330, dependencies: 722 })
  })
  it("finds majors the PR introduces", () => {
    expect(introducedMajors(
      { dependencies: { zod: "^3.25.0", next: "16.4.1", x: "latest" }, devDependencies: { typescript: "~6.0.0" } },
      { dependencies: { zod: "^4.0.0", next: "16.4.2", x: "latest", y: "1.0.0" }, devDependencies: { typescript: "~7.0.0" } },
    )).toEqual([{ name: "zod", from: "^3.25.0", to: "^4.0.0" }, { name: "typescript", from: "~6.0.0", to: "~7.0.0" }])
    expect(introducedMajors(null, {})).toEqual([])
  })
})

describe("evaluateGate", () => {
  it("passes a clean PR", () => {
    expect(evaluateGate(base).passed).toBe(true)
  })
  it("fails on high or critical audit findings", () => {
    const r = evaluateGate({ ...base, auditText: audit(0, 1) })
    expect(r.passed).toBe(false)
    expect(r.failures[0].check).toBe("npm audit")
  })
  it("fails on HIGH or CRITICAL risk unless disabled", () => {
    expect(evaluateGate({ ...base, riskText: '{"risk":"high"}' }).failures[0].check).toBe("Review risk")
    expect(evaluateGate({ ...base, riskText: '{"risk":"critical"}' }).passed).toBe(false)
    expect(evaluateGate({ ...base, riskText: '{"risk":"high"}', failOnHigh: false }).passed).toBe(true)
  })
  it("skips risk when Gemini is unavailable but still fails audit", () => {
    const ok = evaluateGate({ ...base, riskText: "" })
    expect(ok.passed).toBe(true)
    expect(ok.warnings.join()).toMatch(/risk rating unavailable/)
    expect(evaluateGate({ ...base, riskText: "", auditText: audit(2) }).passed).toBe(false)
  })
  it("warns on unreadable audit", () => {
    expect(evaluateGate({ ...base, auditText: "" }).warnings.join()).toMatch(/npm audit/)
  })
  it("fails when dependency-cruiser checked 0 modules", () => {
    expect(evaluateGate({ ...base, cruiserRequested: true, cruiserText: "(0 modules, 0 dependencies cruised)" }).failures[0].check).toBe("dependency-cruiser")
    expect(evaluateGate({ ...base, cruiserRequested: true, cruiserText: "(44 modules, 9 dependencies cruised)" }).passed).toBe(true)
    expect(evaluateGate({ ...base, cruiserRequested: true, cruiserText: "boom", cruiserExit: "2" }).warnings.join()).toMatch(/exit 2/)
    expect(evaluateGate({ ...base, cruiserRequested: true, cruiserText: "dependency-cruiser is not installed; skipped." }).warnings.join()).toMatch(/not installed/)
    expect(evaluateGate({ ...base, cruiserRequested: false, cruiserText: "(0 modules, 0 dependencies cruised)" }).passed).toBe(true)
  })
  it("warns on majors by default and fails when fail-on-majors is true", () => {
    const pk = { basePackage: { dependencies: { zod: "^3.0.0" } }, headPackage: { dependencies: { zod: "^4.0.0" } } }
    const warn = evaluateGate({ ...base, ...pk })
    expect(warn.passed).toBe(true)
    expect(warn.warnings.join()).toMatch(/zod/)
    expect(evaluateGate({ ...base, ...pk, failOnMajors: true }).failures[0].check).toBe("Major upgrades")
  })
  it("lists available majors from npm outdated as warnings", () => {
    const r = evaluateGate({
      ...base,
      headPackage: { dependencies: { zod: "^3.0.0" } },
      outdatedText: JSON.stringify({ zod: { current: "3.25.0", latest: "4.1.0" } }),
    })
    expect(r.passed).toBe(true)
    expect(r.availableMajors.map((m: { name: string }) => m.name)).toEqual(["zod"])
    expect(renderGateSummary(r)).toMatch(/Major upgrades available/)
  })
})

describe("renderGateSummary", () => {
  it("explains failures and fixes", () => {
    const text = renderGateSummary(evaluateGate({ ...base, auditText: audit(1), riskText: "" }))
    expect(text).toMatch(/❌ failed/)
    expect(text).toMatch(/How to fix/)
    expect(text).toMatch(/unavailable \(skipped\)/)
    expect(renderGateSummary(evaluateGate(base))).toMatch(/✅ passed/)
  })
})

// Keep gate output (including ::error annotations) out of the CI log during tests.
const silent = { write: () => true }

describe("runGate", () => {
  let dir: string
  afterEach(async () => {
    process.exitCode = 0
    if (dir) await fs.rm(dir, { recursive: true, force: true })
  })
  it("reads files, writes summary and sets exit code", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"))
    await fs.mkdir(path.join(dir, ".pr-architecture"))
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { zod: "^4.0.0" } }))
    await fs.writeFile(path.join(dir, ".pr-architecture", "base-package.json"), JSON.stringify({ dependencies: { zod: "^3.0.0" } }))
    await fs.writeFile(path.join(dir, ".pr-architecture", "npm-audit.txt"), audit(1))
    await fs.writeFile(path.join(dir, ".pr-architecture", "dependency-cruiser.txt"), "(3 modules, 1 dependencies cruised)")
    const summaryFile = path.join(dir, "summary.md")
    const r = await runGate({ cwd: dir, stdout: silent, stderr: silent, env: { DEPCRUISE_DIRS: "src", FAIL_ON_MAJORS: "true", GITHUB_STEP_SUMMARY: summaryFile } })
    expect(r.failures.map((f) => f.check)).toEqual(["npm audit", "Major upgrades"])
    expect(process.exitCode).toBe(1)
    expect(await fs.readFile(summaryFile, "utf8")).toMatch(/PR intelligence gate/)
    expect(await fs.readFile(path.join(dir, "pr-gate.md"), "utf8")).toMatch(/3 modules/)
  })
  it("passes with missing optional files", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"))
    await fs.mkdir(path.join(dir, ".pr-architecture"))
    await fs.writeFile(path.join(dir, ".pr-architecture", "npm-audit.txt"), audit())
    const r = await runGate({ cwd: dir, stdout: silent, stderr: silent, env: {} })
    expect(r.passed).toBe(true)
  })
})

const highReview = {
  risk: "high",
  summary: "Updates applyWithdraw() to validate withdrawals against the lowest running balance (lowestBalanceFrom()) from the end of the withdrawal date up to the next manual balance update, preventing silent balance capping during accrue().",
  areas: [
    { area: "Data Integrity", status: "pass", evidence: "lib/maths.ts" },
    { area: "Unit Tests", status: "pass", evidence: "tests/gaps.test.ts" },
  ],
  findings: [
    {
      severity: "high",
      ruleId: "ARCH-004",
      evidence: ["lib/maths.ts"],
      impact: "Prevents account balances from going negative due to back-dated withdrawals.",
      recommendation: "Confirm lowestBalanceFrom enforces balance invariants across manual-update boundaries.",
    },
    {
      severity: "medium",
      ruleId: "ARCH-008",
      evidence: ["tests/gaps.test.ts"],
      impact: "Ensures withdrawal logic is thoroughly tested across edge cases.",
      recommendation: "New tests cover back-dated withdrawal scenarios.",
    },
  ],
  dependencies: [],
  followUps: [],
  metadata: {
    number: "84",
    title: "Reject back-dated withdrawals larger than the balance on that date",
    url: "https://github.com/devcamos/drip/pull/84",
    body: "Closes #80\n\nUpdates applyWithdraw() against lowestBalanceFrom().",
  },
}

describe("parseCruiserReport", () => {
  it("reads error counts without changing module parsing", () => {
    const report = parseCruiserReport("x 22 dependency violations (2 errors, 0 warnings). 329 modules, 720 dependencies cruised.")
    expect(report).toMatchObject({ modules: 329, dependencies: 720, violations: 22, errors: 2, warnings: 0, skipped: false })
    expect(parseCruiserReport("dependency-cruiser is not installed; skipped.").skipped).toBe(true)
  })
})

describe("evaluateGate presentation vs gating", () => {
  it("does not fail on high findings when overall risk is medium", () => {
    const r = evaluateGate({
      ...base,
      riskText: JSON.stringify({
        risk: "medium",
        findings: [{ severity: "high", ruleId: "ARCH-004", evidence: ["lib/maths.ts"], impact: "x", recommendation: "y" }],
      }),
    })
    expect(r.passed).toBe(true)
    expect(r.failures).toEqual([])
    const text = renderGateSummary(r)
    expect(text).toMatch(/✅ passed/)
    expect(text).toContain("ARCH-004 high")
    expect(text).toContain(GATE_POLICY.checks.findings.trigger)
    expect(text).toContain("high (advisory)")
  })

  it("does not fail when dependency-cruiser reports errors but checked modules", () => {
    const r = evaluateGate({
      ...base,
      cruiserRequested: true,
      cruiserText: "x 1 dependency violations (1 errors, 0 warnings). 144 modules, 411 dependencies cruised.",
    })
    expect(r.passed).toBe(true)
    expect(r.cruiserDetails.errors).toBe(1)
    const text = renderGateSummary(r)
    expect(text).toMatch(/Pass \(144 modules, 411 dependencies checked; 1 cruiser error\(s\) recorded, advisory\)/)
  })

  it("still only fails majors when fail-on-majors is true", () => {
    const pk = { basePackage: { dependencies: { zod: "^3.0.0" } }, headPackage: { dependencies: { zod: "^4.0.0" } } }
    const warn = renderGateSummary(evaluateGate({ ...base, ...pk }))
    expect(warn).toMatch(/✅ passed/)
    expect(warn).toMatch(/fail-on-majors is off/)
    expect(warn).toContain("There is no PR-label override")
    const fail = evaluateGate({ ...base, ...pk, failOnMajors: true })
    expect(fail.passed).toBe(false)
    expect(renderGateSummary(fail)).toMatch(/Fail \(1: zod \^3\.0\.0 → \^4\.0\.0\)/)
  })
})

describe("renderGateSummary layout", () => {
  it("renders the failure-trigger table, review breakdown and policy matrix for a HIGH-risk PR", () => {
    const r = evaluateGate({
      ...base,
      riskText: JSON.stringify(highReview),
      cruiserRequested: true,
      cruiserText: "✔ no dependency violations found (144 modules, 411 dependencies cruised)",
    })
    expect(r.passed).toBe(false)
    const text = renderGateSummary(r)
    expect(text).toMatch(/^## PR intelligence gate: ❌ failed/m)
    expect(text).toContain("| Check | Type | Outcome | Failure Trigger |")
    expect(text).toContain("| npm audit | Gate | Pass (0 critical, 0 high, 2 moderate, 1 low) | Fails when critical > 0 or high > 0. |")
    expect(text).toContain("| dependency-cruiser | Gate | Pass (144 modules, 411 dependencies checked) |")
    expect(text).toContain("| Majors introduced | Gate | Pass (0) |")
    expect(text).toContain("| Review risk | Gate | Fail (HIGH) |")
    expect(text).toContain("| Architecture findings | RFC / Review | 2 findings (ARCH-004 high, ARCH-008 medium) |")
    expect(text).toContain("Driven by: ARCH-004 (high) in lib/maths.ts.")
    expect(text).toContain("Verify or acknowledge the ARCH-004 high finding in the PR review breakdown below")
    expect(text).not.toMatch(/\*\*Architecture findings:\*\*/)
    expect(text).toContain("## PR review breakdown")
    expect(text).toContain("| Risk | PR Summary |")
    expect(text).toContain("[Reject back-dated withdrawals larger than the balance on that date](https://github.com/devcamos/drip/pull/84)")
    expect(text).toContain("| Data Integrity | ✅ Pass | lib/maths.ts |")
    expect(text).toContain("| Unit Tests | ✅ Pass | tests/gaps.test.ts |")
    expect(text).toContain("| high (advisory) | ARCH-004 | lib/maths.ts |")
    expect(text).toContain("| medium (advisory) | ARCH-008 | tests/gaps.test.ts |")
    expect(text).toContain("<details>")
    expect(text).toContain("<summary>What outcomes can fail the intelligence review?</summary>")
    expect(text).toContain("#### Deterministic CI Gates")
    expect(text).toContain("#### Heuristic / AI Review Signals")
    expect(text).toContain(GATE_POLICY.checks.audit.trigger)
    expect(text).toContain(GATE_POLICY.checks.cruiser.trigger)
    expect(text).toContain(GATE_POLICY.checks.majors.matrixTrigger)
    expect(text).toContain(GATE_POLICY.checks.risk.matrixTrigger)
    expect(text).toContain(GATE_POLICY.checks.findings.trigger)
    expect(text).toContain(GATE_POLICY.checks.areas.trigger)
  })

  it("passes a clean PR with the new table layout", () => {
    const text = renderGateSummary(evaluateGate(base))
    expect(text).toMatch(/✅ passed/)
    expect(text).toContain("| Review risk | Gate | Pass (LOW) |")
    expect(text).toContain("| Architecture findings | RFC / Review | 0 findings |")
    expect(text).not.toContain("### Why it failed")
  })
})
