import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import { MISSING_RULES_NOTICE } from "../scripts/pr-intelligence/comment-layout.mjs"
import {
  buildReviewPrompt,
  describeGeminiError,
  fallbackReview,
  isRetryableGeminiError,
  parseStructuredReview,
  redactSecrets,
  renderStructuredReview,
  reviewSystemInstruction,
} from "../scripts/ai-pr-review.mjs"

describe("PR architecture review failures", () => {
  it("redacts exact and recognizable Gemini API keys", () => {
    const key = "AIzaRealGeminiSecretValue123456789"

    expect(redactSecrets(`Rejected ${key}`, key)).toBe("Rejected [redacted Gemini API key]")
    expect(redactSecrets("Rejected AIzaAnotherGeminiSecretValue98765", "different-key")).toBe(
      "Rejected [redacted Gemini API key]",
    )
  })

  it("turns an authentication error into actionable output without echoing the API message", () => {
    const result = describeGeminiError({
      status: 400,
      message: "API key not valid: AIzaAnotherGeminiSecretValue98765",
    })

    expect(result.reason).toBe("Gemini authentication failed (HTTP 400).")
    expect(result.recovery).toContain("GEMINI_API_KEY")
    expect(JSON.stringify(result)).not.toContain("98765")
  })

  it("explains that an unavailable custom model can be removed", () => {
    const result = describeGeminiError({ status: 404 }, "custom-review-model")

    expect(result.reason).toContain("custom-review-model")
    expect(result.recovery).toContain("GEMINI_REVIEW_MODEL")
  })

  it("identifies free-tier quota exhaustion", () => {
    const result = describeGeminiError({ status: 429 })

    expect(result.reason).toContain("free-tier quota")
    expect(result.recovery).toContain("Google AI Studio")
  })

  it("retries server failures but not configuration or quota failures", () => {
    expect(isRetryableGeminiError({ status: 503 })).toBe(true)
    expect(isRetryableGeminiError({ status: 429 })).toBe(false)
    expect(isRetryableGeminiError({ status: 403 })).toBe(false)
  })

  it("renders structured findings as concise tables", () => {
    const review = parseStructuredReview(
      JSON.stringify({
        risk: "high",
        summary: "Dependency updates are required before merge.",
        areas: [{ area: "Dependencies", status: "warn", evidence: "npm audit failed" }],
        findings: [],
        dependencies: [
          {
            severity: "high",
            package: "next",
            issue: "Known security advisories",
            recommendation: "Upgrade to the patched release",
          },
        ],
        followUps: ["Upgrade Next.js"],
      }),
    )
    const markdown = renderStructuredReview(
      review,
      { url: "https://github.com/example/repo/pull/1" },
      { tests: { output: "pass", exitCode: "0" } },
    )

    expect(markdown).toContain("| HIGH | Dependency updates are required before merge. |")
    expect(markdown).toContain("| Dependencies | ⚠️ Warn | npm audit failed |")
    expect(markdown).toContain("| — | — | — | No material findings. |")
    expect(markdown).toContain("| high | next | Known security advisories |")
    expect(markdown).toContain("- [ ] Upgrade Next.js")
    expect(markdown).toContain("## PR review breakdown")
  })

  it("marks high architecture findings as blocks-gate by default", () => {
    const review = parseStructuredReview(
      JSON.stringify({
        risk: "high",
        summary: "Balance invariants changed.",
        areas: [{ area: "Data Integrity", status: "pass", evidence: "lib/maths.ts" }],
        findings: [
          {
            severity: "high",
            ruleId: "ARCH-004",
            evidence: ["lib/maths.ts"],
            impact: "Prevents account balances from going negative due to back-dated withdrawals.",
            recommendation: "Confirm lowestBalanceFrom enforces balance invariants across manual-update boundaries.",
          },
        ],
        dependencies: [],
        followUps: [],
      }),
    )
    const markdown = renderStructuredReview(review, { title: "Reject back-dated withdrawals", number: "84", url: "https://github.com/devcamos/drip/pull/84" }, {})
    expect(markdown).toContain("high (blocks gate)")
    expect(markdown).toContain("ARCH-004")
    expect(markdown).toContain("[Reject back-dated withdrawals](https://github.com/devcamos/drip/pull/84)")
  })

  it("rejects invalid structured responses", () => {
    expect(() => parseStructuredReview('{"risk":"unknown"}')).toThrow(
      "invalid structured review",
    )
  })

  it("caps rendered sections to the lightweight report limits", () => {
    const item = (index: number) => ({
      area: `Area ${index}`,
      status: "pass",
      evidence: `Evidence ${index}`,
    })
    const review = {
      risk: "low",
      summary: "No material risks.",
      areas: Array.from({ length: 8 }, (_, index) => item(index + 1)),
      findings: [],
      dependencies: [],
      followUps: Array.from({ length: 5 }, (_, index) => `Follow-up ${index + 1}`),
    }

    const markdown = renderStructuredReview(review, {}, {})

    expect(markdown).toContain("Area 6")
    expect(markdown).not.toContain("Area 7")
    expect(markdown).toContain("Follow-up 3")
    expect(markdown).not.toContain("Follow-up 4")
  })

  it("includes the upgrade table in both structured and fallback reviews", () => {
    const table = "## Dependency upgrade suggestions\n\n| x |"
    const review = { risk: "low", summary: "ok", areas: [], findings: [], dependencies: [], followUps: [] }
    expect(renderStructuredReview(review, {}, {}, table)).toContain(table)
    const fallback = fallbackReview("no key", "add key", { number: "3", title: "T" }, {}, table)
    expect(fallback).toContain(table)
    expect(fallback).toContain("#3")
  })
})


describe("PR-focused review prompt", () => {
  const diagnostics = {
    npmAudit: { output: "{}", exitCode: "0" },
    npmLs: { output: "ok", exitCode: "0" },
    tests: { output: "ok", exitCode: "0" },
    build: { output: "ok", exitCode: "0" },
    dependencyCruiser: { output: "skipped", exitCode: "0" },
  }

  it("instructs residual-risk rating and defect-based finding severity", () => {
    const prompt = buildReviewPrompt({
      rules: { project: "Demo", rules: [{ id: "ARCH-004", severity: "high", title: "Balances stay non-negative" }] },
      rulesFound: true,
      metadata: { number: "84", title: "fix: reject back-dated withdrawals" },
      changedFiles: "M\tlib/maths.ts",
      diff: "diff --git a/lib/maths.ts b/lib/maths.ts",
      upgrades: [],
      ...diagnostics,
    })

    expect(prompt).toContain("Focus on the diff itself, not the overall application")
    expect(prompt).toContain("residual risk")
    expect(prompt).toContain("not HIGH just because the area is important")
    expect(prompt).toContain("Do not raise a finding to confirm correct behaviour")
    expect(prompt).toContain("severity is a ceiling")
    expect(prompt).toContain("enhanced feedback")
    expect(prompt).toContain("they do not define the scope of this review")
    expect(prompt).toContain("ARCH-004")
    expect(reviewSystemInstruction({ project: "Demo" }, true)).toContain("residual risk")
    expect(reviewSystemInstruction({ project: "Demo" }, true)).toContain("enhanced feedback")
  })

  it("uses a PR-focused rules-optional section when no rules file is present", () => {
    const prompt = buildReviewPrompt({
      rules: null,
      rulesFound: false,
      metadata: { number: "1", title: "fix typo" },
      changedFiles: "M\tREADME.md",
      diff: "diff --git a/README.md b/README.md",
      upgrades: [],
      ...diagnostics,
    })

    expect(prompt).toContain("No architecture rules file was provided")
    expect(prompt).toContain("PR-focused review only")
    expect(prompt).not.toContain("Architecture rules (enhanced feedback")
    expect(reviewSystemInstruction(null, false)).toContain("If no rules are supplied")
  })
})

const drip84ChangedFiles = readFileSync("tests/fixtures/drip-84-changed-files.txt", "utf8")
const drip84Diff = readFileSync("tests/fixtures/drip-84.diff", "utf8")

describe("PR-focused comment layout", () => {
  it("leads with what this PR changes, then risk, then findings", () => {
    const review = parseStructuredReview(
      JSON.stringify({
        risk: "low",
        summary: "Rejects oversized back-dated withdrawals.",
        changes: {
          added: "Invariant tests for lowestBalanceFrom boundaries.",
          refactored: "applyWithdraw now caps against the historical low.",
          removed: "None",
        },
        areas: [{ area: "Data Integrity", status: "pass", evidence: "lib/maths.ts" }],
        findings: [],
        dependencies: [],
        followUps: [],
        architectureNotes: ["ARCH-004 is relevant to the withdrawal invariant."],
      }),
    )
    review.changedFiles = drip84ChangedFiles
    review.diff = drip84Diff
    const markdown = renderStructuredReview(review, { title: "Reject back-dated withdrawals", number: "84" }, {})
    const summary = markdown.indexOf("### Summary")
    const what = markdown.indexOf("### What this PR changes")
    const breakdown = markdown.indexOf("## PR review breakdown")
    const risk = markdown.indexOf("### Risk")
    const findings = markdown.indexOf("### Findings")
    expect(summary).toBeGreaterThan(-1)
    expect(markdown).toContain("Rejects oversized back-dated withdrawals.")
    expect(what).toBeGreaterThan(summary)
    expect(breakdown).toBeGreaterThan(what)
    expect(risk).toBeGreaterThan(breakdown)
    expect(findings).toBeGreaterThan(risk)
    expect(markdown.split("### What this PR changes").length - 1).toBe(1)
    expect(markdown).toContain("`lowestBalanceFrom` in `lib/maths.ts`")
    expect(markdown).toContain("Invariant tests for lowestBalanceFrom boundaries.")
    expect(markdown).toContain("`applyWithdraw` in `lib/maths.ts`")
    expect(markdown).toContain("applyWithdraw now caps against the historical low.")
    expect(markdown).toContain("**Removed:** None")
    expect(markdown).toContain("### Architecture notes")
    expect(markdown).toContain("ARCH-004 is relevant to the withdrawal invariant.")
  })

  it("shows the missing-rules notice in the comment", () => {
    const review = {
      risk: "low",
      summary: "Docs typo only.",
      areas: [],
      findings: [],
      dependencies: [],
      followUps: [],
      rulesFound: false,
    }
    const markdown = renderStructuredReview(review, {}, {})
    expect(markdown).toContain(MISSING_RULES_NOTICE)
  })
})
