import { describe, expect, it } from "vitest"

import {
  describeGeminiError,
  fallbackReview,
  isRetryableGeminiError,
  parseStructuredReview,
  redactSecrets,
  renderStructuredReview,
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

    expect(markdown).toContain("| **HIGH** | Dependency updates are required before merge. |")
    expect(markdown).toContain("| Dependencies | ⚠️ Warn | npm audit failed |")
    expect(markdown).toContain("| — | — | — | No material architecture findings. |")
    expect(markdown).toContain("| high | next | Known security advisories |")
    expect(markdown).toContain("- [ ] Upgrade Next.js")
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
