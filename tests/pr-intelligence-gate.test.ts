import { readFileSync } from "node:fs"
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
  renderApprovalComment,
  renderGateSummary,
  runGate,
  suggestRelease,
  severityStatus,
} from "../scripts/pr-intelligence/gate.mjs"
import { compactProse, completeProse } from "../scripts/pr-intelligence/markdown.mjs"

const drip84ChangedFiles = readFileSync("tests/fixtures/drip-84-changed-files.txt", "utf8")
const drip84Diff = readFileSync("tests/fixtures/drip-84.diff", "utf8")
const withDrip84Diff = { changedFiles: drip84ChangedFiles, diffText: drip84Diff }

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
  it("fails on majors by default and warns when fail-on-majors is false", () => {
    const pk = { basePackage: { dependencies: { zod: "^3.0.0" } }, headPackage: { dependencies: { zod: "^4.0.0" } } }
    const fail = evaluateGate({ ...base, ...pk })
    expect(fail.passed).toBe(false)
    expect(fail.failures[0].check).toBe("Majors introduced")
    const warn = evaluateGate({ ...base, ...pk, failOnMajors: false })
    expect(warn.passed).toBe(true)
    expect(warn.warnings.join()).toMatch(/zod/)
  })
  it("allows majors when the allow-major-upgrade label is present", () => {
    const pk = { basePackage: { dependencies: { zod: "^3.0.0" } }, headPackage: { dependencies: { zod: "^4.0.0" } } }
    const r = evaluateGate({ ...base, ...pk, labels: ["allow-major-upgrade"] })
    expect(r.passed).toBe(true)
    expect(r.warnings.join()).toMatch(/allow-major-upgrade/)
    expect(renderGateSummary(r)).toMatch(/allowed by allow-major-upgrade/)
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
    expect(r.failures.map((f) => f.check)).toEqual(["npm audit", "Majors introduced"])
    expect(process.exitCode).toBe(1)
    expect(await fs.readFile(summaryFile, "utf8")).toMatch(/PR intelligence gate/)
    expect(await fs.readFile(path.join(dir, "pr-gate.md"), "utf8")).toMatch(/3 modules/)
    expect(await fs.readFile(path.join(dir, "pr-approval.md"), "utf8")).toMatch(/not approved/)
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

describe("evaluateGate tightened matrix", () => {
  it("fails on high findings even when overall risk is medium", () => {
    const r = evaluateGate({
      ...base,
      riskText: JSON.stringify({
        risk: "medium",
        findings: [{ severity: "high", ruleId: "ARCH-004", evidence: ["lib/maths.ts"], impact: "x", recommendation: "y" }],
      }),
    })
    expect(r.passed).toBe(false)
    expect(r.failures[0].check).toBe("Architecture findings")
    const text = renderGateSummary(r)
    expect(text).toMatch(/❌ failed/)
    expect(text).toContain("ARCH-004 high")
    expect(text).toContain(GATE_POLICY.checks.findings.matrixTrigger)
    expect(text).toContain("high (blocks gate)")
  })

  it("keeps medium findings and area warns advisory", () => {
    const r = evaluateGate({
      ...base,
      riskText: JSON.stringify({
        risk: "low",
        findings: [{ severity: "medium", ruleId: "ARCH-008", evidence: ["tests/gaps.test.ts"], impact: "x", recommendation: "y" }],
        areas: [{ area: "Docs", status: "warn", evidence: "README.md" }],
      }),
    })
    expect(r.passed).toBe(true)
    expect(renderGateSummary(r)).toContain("medium (advisory)")
  })

  it("does not fail high findings when fail-on-high-findings is off", () => {
    const r = evaluateGate({
      ...base,
      failOnHighFindings: false,
      riskText: JSON.stringify({
        risk: "medium",
        findings: [{ severity: "high", ruleId: "ARCH-004", evidence: ["lib/maths.ts"], impact: "x", recommendation: "y" }],
      }),
    })
    expect(r.passed).toBe(true)
    expect(renderGateSummary(r)).toContain("high (advisory)")
  })

  it("fails when dependency-cruiser reports errors even if modules were checked", () => {
    const r = evaluateGate({
      ...base,
      cruiserRequested: true,
      cruiserText: "x 1 dependency violations (1 errors, 0 warnings). 144 modules, 411 dependencies cruised.",
    })
    expect(r.passed).toBe(false)
    expect(r.failures[0].check).toBe("dependency-cruiser")
    expect(r.cruiserDetails.errors).toBe(1)
    const text = renderGateSummary(r)
    expect(text).toMatch(/Fail \(144 modules, 411 dependencies checked; 1 cruiser error\(s\)\)/)
  })

  it("fails a failed review area and allows opting out", () => {
    const fail = evaluateGate({
      ...base,
      riskText: JSON.stringify({
        risk: "low",
        areas: [{ area: "Data Integrity", status: "fail", evidence: "lib/maths.ts" }],
        findings: [],
      }),
    })
    expect(fail.passed).toBe(false)
    expect(fail.failures[0].check).toBe("Areas")
    expect(renderGateSummary(fail)).toContain("❌ Fail (blocks gate)")
    const ok = evaluateGate({
      ...base,
      failOnAreaFail: false,
      riskText: JSON.stringify({
        risk: "low",
        areas: [{ area: "Data Integrity", status: "fail", evidence: "lib/maths.ts" }],
        findings: [],
      }),
    })
    expect(ok.passed).toBe(true)
  })

  it("renders a majors failure and the fail-on-majors opt-out", () => {
    const pk = { basePackage: { dependencies: { zod: "^3.0.0" } }, headPackage: { dependencies: { zod: "^4.0.0" } } }
    const fail = evaluateGate({ ...base, ...pk })
    expect(fail.passed).toBe(false)
    expect(renderGateSummary(fail)).toMatch(/Fail \(1: zod \^3\.0\.0 → \^4\.0\.0\)/)
    const warn = renderGateSummary(evaluateGate({ ...base, ...pk, failOnMajors: false }))
    expect(warn).toMatch(/✅ passed/)
    expect(warn).toMatch(/fail-on-majors is off/)
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
    expect(text).toContain("| Architecture findings | RFC / Review | Fail (2 findings (ARCH-004 high, ARCH-008 medium)) |")
    expect(text).toContain("| Areas | RFC / Review | Pass (no failed areas) |")
    expect(text).toContain("Driven by: ARCH-004 (high) in lib/maths.ts.")
    expect(text).toContain("Verify or acknowledge the ARCH-004 high finding in the PR review breakdown below")
    expect(text).toContain("## PR review breakdown")
    expect(text).toContain("| Risk | PR Summary |")
    expect(text).toContain("[Reject back-dated withdrawals larger than the balance on that date](https://github.com/devcamos/drip/pull/84)")
    expect(text).toContain("| Data Integrity | ✅ Pass | lib/maths.ts |")
    expect(text).toContain("| Unit Tests | ✅ Pass | tests/gaps.test.ts |")
    expect(text).toContain("| high (blocks gate) | ARCH-004 | lib/maths.ts |")
    expect(text).toContain("| medium (advisory) | ARCH-008 | tests/gaps.test.ts |")
    expect(text).toContain("### Release suggestion")
    expect(text).toContain("**patch**")
    expect(text).toContain("### Severity status")
    expect(text).toMatch(/Blocked:.*ARCH-004/)
    expect(renderApprovalComment(r)).toMatch(/not approved/)
    expect(r.failures.map((f) => f.check)).toEqual(["Review risk", "Architecture findings"])
    expect(text).toContain("<details>")
    expect(text).toContain("<summary>What outcomes can fail the intelligence review?</summary>")
    expect(text).toContain("#### Deterministic CI Gates")
    expect(text).toContain("#### Heuristic / AI Review Signals")
    expect(text).toContain(GATE_POLICY.checks.audit.trigger)
    expect(text).toContain(GATE_POLICY.checks.cruiser.trigger)
    expect(text).toContain(GATE_POLICY.checks.majors.matrixTrigger)
    expect(text).toContain(GATE_POLICY.checks.risk.matrixTrigger)
    expect(text).toContain(GATE_POLICY.checks.findings.matrixTrigger)
    expect(text).toContain(GATE_POLICY.checks.areas.matrixTrigger)
  })

  it("passes a clean PR with the new table layout", () => {
    const text = renderGateSummary(evaluateGate(base))
    expect(text).toMatch(/✅ passed/)
    expect(text).toContain("| Review risk | Gate | Pass (LOW) |")
    expect(text).toContain("| Architecture findings | RFC / Review | Pass (0 findings) |")
    expect(text).toContain("| Areas | RFC / Review | Pass (no failed areas) |")
    expect(text).toContain("**Clear** — no high or critical blocking items remain.")
    expect(text).not.toContain("### Why it failed")
    expect(renderApprovalComment(evaluateGate(base))).toBe("✅ PR intelligence: approved — severity clear, release: patch")
  })

  it("leads a passed gate comment with the PR logic summary and change list ahead of the checks table", () => {
    const review = {
      risk: "low",
      summary: "Back-dated withdrawals are rejected when they would exceed the lowest running balance up to the next manual update.",
      changes: {
        added: "lowestBalanceFrom and invariant tests.",
        refactored: "applyWithdraw now checks the historical low.",
        removed: "None",
      },
      areas: [],
      findings: [],
      dependencies: [],
      followUps: [],
    }
    const text = renderGateSummary(evaluateGate({ ...base, ...withDrip84Diff, riskText: JSON.stringify(review) }))
    expect(text).toMatch(/^## PR intelligence gate: ✅ passed/m)
    const heading = text.indexOf("## PR intelligence gate: ✅ passed")
    const summary = text.indexOf("### Summary")
    const logic = text.indexOf("Back-dated withdrawals are rejected")
    const what = text.indexOf("### What this PR changes")
    const table = text.indexOf("| Check | Type | Outcome | Failure Trigger |")
    const breakdown = text.indexOf("## PR review breakdown")
    expect(summary).toBeGreaterThan(heading)
    expect(logic).toBeGreaterThan(summary)
    expect(what).toBeGreaterThan(logic)
    expect(table).toBeGreaterThan(what)
    expect(breakdown).toBeGreaterThan(table)
    expect(text.split("### What this PR changes").length - 1).toBe(1)
    expect(text.slice(breakdown)).not.toContain("### What this PR changes")
    expect(text).toContain("`lowestBalanceFrom` in `lib/maths.ts`")
    expect(text).toContain("lowestBalanceFrom and invariant tests.")
    expect(text).toContain("`applyWithdraw` in `lib/maths.ts`")
    expect(text).toContain("applyWithdraw now checks the historical low.")
    expect(text).toContain("**Tests:** `tests/gaps.test.ts`")
    expect(text).not.toMatch(/\*\*Refactored:\*\*.*`tests\/gaps\.test\.ts`/)
    expect(text).toContain("**Removed:** None")
    expect(renderApprovalComment(evaluateGate({ ...base, ...withDrip84Diff, riskText: JSON.stringify(review) }))).toBe(
      "✅ PR intelligence: approved — severity clear, release: patch",
    )
  })

  it("leads a failed gate comment with the same summary block ahead of the checks table", () => {
    const review = {
      ...highReview,
      changes: {
        added: "invariant tests",
        refactored: "applyWithdraw",
        removed: "None",
      },
    }
    const text = renderGateSummary(evaluateGate({ ...base, ...withDrip84Diff, riskText: JSON.stringify(review) }))
    expect(text).toMatch(/^## PR intelligence gate: ❌ failed/m)
    const heading = text.indexOf("## PR intelligence gate: ❌ failed")
    const summary = text.indexOf("### Summary")
    const logic = text.indexOf("Updates applyWithdraw()")
    const what = text.indexOf("### What this PR changes")
    const table = text.indexOf("| Check | Type | Outcome | Failure Trigger |")
    const breakdown = text.indexOf("## PR review breakdown")
    expect(summary).toBeGreaterThan(heading)
    expect(logic).toBeGreaterThan(summary)
    expect(what).toBeGreaterThan(logic)
    expect(table).toBeGreaterThan(what)
    expect(text.split("### What this PR changes").length - 1).toBe(1)
    expect(text.slice(breakdown)).not.toContain("### What this PR changes")
  })

  it("keeps long Added and Refactored lines intact through a sentence boundary", () => {
    const added = "A new function lowestBalanceFrom was added to lib/maths.ts to calculate the lowest running balance from a given date until the next manual balance update. New unit tests for back-dated withdrawals and ARCH-004 invariants were added to tests/gaps.test.ts."
    const refactored = "The applyWithdraw function in lib/maths.ts was updated to use the new lowestBalanceFrom function, adding a check to reject withdrawals that would lead to a negative balance on their date or any subsequent date until the next manual balance update."
    const text = renderGateSummary(evaluateGate({
      ...base,
      ...withDrip84Diff,
      riskText: JSON.stringify({
        risk: "low",
        summary: "This PR introduces a new lowestBalanceFrom function to lib/maths.ts and integrates it into applyWithdraw to prevent back-dated withdrawals from causing negative balances at any point in the account's history up to the next manual balance update. New tests validate this behavior.",
        changes: { added, refactored, removed: "None" },
        areas: [],
        findings: [],
        dependencies: [],
        followUps: [],
      }),
    }))
    expect(text).toContain("### Summary")
    expect(text).toContain("New tests validate this behavior.")
    expect(text).toContain("`lowestBalanceFrom` in `lib/maths.ts`")
    expect(text).toContain("A new function lowestBalanceFrom was added to lib/maths.ts to calculate the lowest running balance from a given date until the next manual balance update.")
    expect(text).toContain("`applyWithdraw` in `lib/maths.ts`")
    expect(text).toContain(refactored)
    expect(text).toContain("**Tests:** `tests/gaps.test.ts`")
    expect(text).not.toContain("…")
    expect(text).not.toMatch(/added to…/)
    expect(text).not.toMatch(/next manual b…/)
    expect(text).not.toMatch(/lead to a…/)
  })
})

describe("suggestRelease and severity status", () => {
  it("maps conventional titles, labels and fix branches", () => {
    expect(suggestRelease({ title: "fix: reject oversized withdrawals" }).level).toBe("patch")
    expect(suggestRelease({ title: "feat: add payout calendar" }).level).toBe("minor")
    expect(suggestRelease({ title: "feat!: switch ledger format" }).level).toBe("major")
    expect(suggestRelease({ title: "Update maths", body: "BREAKING CHANGE: new shape" }).level).toBe("major")
    expect(suggestRelease({ title: "Reject back-dated withdrawals", body: "- [x] **No breaking DB migrations**\n- [x] **API Contract:** No breaking changes." }).level).toBe("patch")
    expect(suggestRelease({ title: "Bump Zod", labels: ["semver:minor"] }).level).toBe("minor")
    expect(suggestRelease({ title: "Reject back-dated withdrawals", headRef: "fix/80-backdated-withdrawal" }).level).toBe("patch")
    expect(suggestRelease({ title: "Docs only", changedFiles: "M\tdocs/README.md\nM\tAGENTS.md" }).level).toBe("patch")
  })

  it("is severity-clear only when no high or critical blockers remain", () => {
    expect(severityStatus(evaluateGate(base)).clear).toBe(true)
    const blocked = evaluateGate({ ...base, riskText: '{"risk":"high"}' })
    expect(blocked.severityStatus.clear).toBe(false)
    expect(blocked.severityStatus.summary).toMatch(/HIGH/)
    expect(renderApprovalComment(blocked)).toMatch(/not approved/)
  })
})

describe("compactProse", () => {
  it("keeps text that already fits the limit", () => {
    expect(compactProse("None", 500)).toBe("None")
  })

  it("cuts at the last complete sentence instead of mid-sentence", () => {
    const first = "A new function lowestBalanceFrom was added to lib/maths.ts to calculate the lowest running balance from a given date until the next manual balance update."
    const second = "New unit tests for back-dated withdrawals and ARCH-004 invariants were added to tests/gaps.test.ts."
    expect(compactProse(`${first} ${second}`, 240)).toBe(first)
    expect(compactProse(`${first} ${second}`, 240)).not.toContain("…")
  })

  it("falls back to a word boundary with an ellipsis when there is no sentence end", () => {
    const text = "The applyWithdraw function in lib/maths.ts was updated to use the new lowestBalanceFrom function adding a check to reject withdrawals that would lead to a negative balance on their date or any subsequent date until the next manual balance update"
    const result = compactProse(text, 240)
    expect(result.endsWith("…")).toBe(true)
    const kept = result.slice(0, -1)
    expect(text.startsWith(kept)).toBe(true)
    expect(text[kept.length]).toBe(" ")
    expect(result.length).toBeLessThanOrEqual(241)
  })
})

describe("completeProse", () => {
  it("keeps a single long sentence intact instead of cutting it with an ellipsis", () => {
    const sentence = "The applyWithdraw function in lib/maths.ts was updated to use the new lowestBalanceFrom function, adding a check to reject withdrawals that would lead to a negative balance on their date or any subsequent date until the next manual balance update."
    expect(sentence.length).toBeGreaterThan(160)
    expect(completeProse(sentence, 160)).toBe(sentence)
    expect(completeProse(sentence, 160)).not.toContain("…")
    expect(completeProse(sentence, 500)).toBe(sentence)
  })

  it("cuts at the last complete sentence when more than one sentence exceeds the limit", () => {
    const first = "A new function lowestBalanceFrom was added to lib/maths.ts to calculate the lowest running balance from a given date until the next manual balance update."
    const second = "New unit tests for back-dated withdrawals and ARCH-004 invariants were added to tests/gaps.test.ts."
    expect(completeProse(`${first} ${second}`, 240)).toBe(first)
    expect(completeProse(`${first} ${second}`, 240)).not.toContain("…")
  })
})
