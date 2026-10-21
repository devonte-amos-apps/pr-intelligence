import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  auditCounts,
  evaluateGate,
  introducedMajors,
  parseCruiserModules,
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
    const r = await runGate({ cwd: dir, env: { DEPCRUISE_DIRS: "src", FAIL_ON_MAJORS: "true", GITHUB_STEP_SUMMARY: summaryFile } })
    expect(r.failures.map((f) => f.check)).toEqual(["npm audit", "Major upgrades"])
    expect(process.exitCode).toBe(1)
    expect(await fs.readFile(summaryFile, "utf8")).toMatch(/PR intelligence gate/)
    expect(await fs.readFile(path.join(dir, "pr-gate.md"), "utf8")).toMatch(/3 modules/)
  })
  it("passes with missing optional files", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"))
    await fs.mkdir(path.join(dir, ".pr-architecture"))
    await fs.writeFile(path.join(dir, ".pr-architecture", "npm-audit.txt"), audit())
    const r = await runGate({ cwd: dir, env: {} })
    expect(r.passed).toBe(true)
  })
})
