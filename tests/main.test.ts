import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { main } from "../scripts/ai-pr-review.mjs"

let dir: string
const env = { ...process.env }

async function setup({ rules = '{"project":"Demo","rules":[]}' } = {}) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "pri-"))
  await fs.mkdir(path.join(dir, ".pr-architecture"))
  await fs.writeFile(path.join(dir, "rules.json"), rules)
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { react: "^18.0.0" } }))
  const files: Record<string, string> = {
    "changed-files.txt": "M\tsrc/a.ts",
    "diff.patch": "x".repeat(50_000),
    "npm-audit.txt": "{}",
    "npm-audit.exit": "0",
    "tests.txt": "ok",
    "tests.exit": "1",
    "build.txt": "build skipped",
    "build.exit": "0",
    "npm-outdated.txt": JSON.stringify({ react: { current: "18.3.1", latest: "19.2.0" } }),
  }
  for (const [name, value] of Object.entries(files)) await fs.writeFile(path.join(dir, ".pr-architecture", name), value)
  process.env.RULES_PATH = "rules.json"
  process.env.PR_NUMBER = "7"
}

const review = { risk: "medium", summary: "Fine", areas: [], findings: [], dependencies: [], followUps: [] }
const read = () => fs.readFile(path.join(dir, "pr-review.md"), "utf8")

beforeEach(() => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true)
  process.exitCode = 0
})
afterEach(async () => {
  process.env = { ...env }
  process.exitCode = 0
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

describe("main", () => {
  it("writes a structured review with the upgrade table", async () => {
    await setup()
    process.env.GEMINI_API_KEY = "k"
    process.env.GITHUB_STEP_SUMMARY = path.join(dir, "summary.md")
    const generateContent = vi.fn(async () => ({ text: JSON.stringify(review) }))
    await main({ cwd: dir, createClient: async () => ({ models: { generateContent } }), fetchImpl: null as never })
    const out = await read()
    expect(out).toContain("**MEDIUM**")
    expect(out).toContain("| `react` | prod | 18.3.1 | 19.2.0 | 🔴 major (key framework)")
    expect(out).toContain("| Tests | failed (exit 1) |")
    expect(out).toContain("| Build | skipped |")
    const call = generateContent.mock.calls[0][0] as { contents: string; config: { systemInstruction: string } }
    expect(call.contents).toContain("dependency_upgrades")
    expect(call.contents).toContain("[truncated")
    expect(call.config.systemInstruction).toContain("Demo")
    expect(process.exitCode).toBe(0)
  })

  it("falls back with the upgrade table when the key is missing", async () => {
    await setup()
    delete process.env.GEMINI_API_KEY
    process.env.GITHUB_STEP_SUMMARY = path.join(dir, "summary.md")
    await main({ cwd: dir, fetchImpl: null as never })
    expect(await read()).toContain("Dependency upgrade suggestions")
    expect(await fs.readFile(path.join(dir, "summary.md"), "utf8")).toContain("GEMINI_API_KEY")
    expect(process.exitCode).toBe(1)
  })

  it("reports invalid rules JSON", async () => {
    await setup({ rules: "{" })
    process.env.GEMINI_API_KEY = "k"
    process.env.GITHUB_STEP_SUMMARY = "/nonexistent/dir/summary.md"
    await main({ cwd: dir, fetchImpl: null as never })
    expect(await read()).toContain("invalid JSON")
  })

  it("reports missing rules file", async () => {
    await setup()
    process.env.RULES_PATH = "missing.json"
    await main({ cwd: dir, fetchImpl: null as never })
    expect(await read()).toContain("Review inputs could not be loaded")
  })

  it("retries server errors and reports empty or failed responses", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 2000 })
    await setup()
    process.env.GEMINI_API_KEY = "k"
    let calls = 0
    const generateContent = vi.fn(async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("down"), { status: 503 })
      return { text: "" }
    })
    await main({ cwd: dir, createClient: async () => ({ models: { generateContent } }), fetchImpl: null as never })
    expect(generateContent).toHaveBeenCalledTimes(2)
    expect(await read()).toContain("empty review")
    vi.useRealTimers()
  })

  it("survives an unreadable package.json", async () => {
    await setup()
    await fs.writeFile(path.join(dir, "package.json"), "{")
    process.env.GEMINI_API_KEY = "k"
    await main({ cwd: dir, createClient: async () => ({ models: { generateContent: async () => ({ text: JSON.stringify(review) }) } }), fetchImpl: null as never })
    expect(await read()).not.toContain("Dependency upgrade suggestions")
  })
})
