import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import {
  deriveChangesFromDiff,
  diffLeavesNonV1Pin,
  filterFollowUps,
  parseDiffSymbols,
} from "../scripts/pr-intelligence/changes-from-diff.mjs"
import { renderChangeList, renderDependenciesAndFollowUps, renderGateLead } from "../scripts/pr-intelligence/comment-layout.mjs"

const changedFiles = readFileSync("tests/fixtures/drip-84-changed-files.txt", "utf8")
const drip84Diff = readFileSync("tests/fixtures/drip-84.diff", "utf8")

const review = {
  risk: "low",
  summary: "This PR introduces a new lowestBalanceFrom function to lib/maths.ts and integrates it into applyWithdraw. New tests validate this behavior.",
  changes: {
    added: "A new function lowestBalanceFrom was added to lib/maths.ts to calculate the lowest running balance from a given date until the next manual balance update. New unit tests for back-dated withdrawals and ARCH-004 invariants were added to tests/gaps.test.ts.",
    refactored: "The applyWithdraw function in lib/maths.ts was updated to use the new lowestBalanceFrom function.",
    removed: "None",
  },
  followUps: [
    "Revert the TEST pin to @v1 and drop the temporary tool-ref before merge.",
    "Add a changelog entry.",
  ],
}

describe("parseDiffSymbols", () => {
  it("lists added and body-modified top-level functions from the drip #84 fixture", () => {
    const symbols = parseDiffSymbols(drip84Diff)
    expect(symbols.get("lib/maths.ts")).toEqual({
      added: ["lowestBalanceFrom"],
      modified: ["applyWithdraw"],
      removed: [],
    })
    expect(symbols.get("tests/gaps.test.ts")).toEqual({ added: [], modified: [], removed: [] })
  })

  it("ignores a previous-function hunk header when a later context line declares the real function", () => {
    const diff = `diff --git a/lib/maths.ts b/lib/maths.ts
--- a/lib/maths.ts
+++ b/lib/maths.ts
@@ -1,4 +1,5 @@ export function applyTopUp(a) {
 export function applyWithdraw(a, amount, date) {
   if (!(amount > 0)) throw new Error("bad")
+  if (amount > lowest(a, date)) throw new Error("date")
   return a
 }
`
    expect(parseDiffSymbols(diff).get("lib/maths.ts")).toEqual({
      added: [],
      modified: ["applyWithdraw"],
      removed: [],
    })
  })

  it("treats a declaration present on both sides as modified", () => {
    const diff = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-export function foo(a: number) {
+export function foo(a: string) {
   return a
 }
`
    expect(parseDiffSymbols(diff).get("src/a.ts")).toEqual({
      added: [],
      modified: ["foo"],
      removed: [],
    })
  })

  it("captures exported classes, const functions, and removals", () => {
    const diff = `diff --git a/src/a.mjs b/src/a.mjs
--- a/src/a.mjs
+++ b/src/a.mjs
@@ -1,6 +1,6 @@
-export class OldThing {}
-const gone = () => 1
+export class NewThing {}
+export const keep = (x) => x
`
    expect(parseDiffSymbols(diff).get("src/a.mjs")).toEqual({
      added: ["NewThing", "keep"],
      modified: [],
      removed: ["OldThing", "gone"],
    })
  })
})

describe("deriveChangesFromDiff", () => {
  it("uses symbols for maths.ts and file-level fallback for tests without top-level declarations", () => {
    const changes = deriveChangesFromDiff({ changedFiles, diff: drip84Diff, review })
    expect(changes.kind).toBe("symbols")
    expect(changes.added).toEqual([
      expect.objectContaining({
        name: "lowestBalanceFrom",
        path: "lib/maths.ts",
        description: expect.stringContaining("lowestBalanceFrom was added"),
      }),
    ])
    expect(changes.modified).toEqual([
      expect.objectContaining({
        name: "applyWithdraw",
        path: "lib/maths.ts",
        description: expect.stringContaining("applyWithdraw function"),
      }),
      expect.objectContaining({
        name: "",
        path: "tests/gaps.test.ts",
        description: expect.stringContaining("tests/gaps.test.ts"),
      }),
    ])
    expect(changes.removed).toEqual([])
  })

  it("does not attach an AI sentence that does not mention the symbol", () => {
    const changes = deriveChangesFromDiff({
      changedFiles,
      diff: drip84Diff,
      review: { summary: "Improves withdrawal safety.", changes: { added: "New helpers.", refactored: "Safer checks.", removed: "None" } },
    })
    expect(changes.added[0].description).toBe("")
    expect(changes.modified[0].description).toBe("")
  })

  it("falls back to file-level added/modified/removed/renamed when no symbols exist", () => {
    const files = "A\tdocs/guide.md\nM\tREADME.md\nD\told.txt\nR100\tsrc/a.ts\tsrc/b.ts\n"
    const changes = deriveChangesFromDiff({ changedFiles: files, diff: "" })
    expect(changes).toEqual({
      kind: "files",
      added: [{ path: "docs/guide.md" }],
      modified: [{ path: "README.md" }],
      removed: [{ path: "old.txt" }],
      renamed: [{ from: "src/a.ts", path: "src/b.ts" }],
    })
  })
})

describe("stale pin follow-ups", () => {
  it("does not treat an unchanged @v1 workflow as a leftover pin", () => {
    expect(diffLeavesNonV1Pin(drip84Diff, changedFiles)).toBe(false)
    expect(filterFollowUps(review.followUps, { diff: drip84Diff, changedFiles })).toEqual(["Add a changelog entry."])
  })

  it("keeps pin follow-ups when the new workflow side still uses a SHA pin", () => {
    const files = "M\t.github/workflows/pr-architecture-intelligence.yml\n"
    const diff = `diff --git a/.github/workflows/pr-architecture-intelligence.yml b/.github/workflows/pr-architecture-intelligence.yml
--- a/.github/workflows/pr-architecture-intelligence.yml
+++ b/.github/workflows/pr-architecture-intelligence.yml
@@ -10,6 +10,7 @@
     uses: devonte-amos-apps/pr-intelligence/.github/workflows/pr-architecture-intelligence.yml@abc1234deadbeef
+    with:
+      tool-ref: abc1234deadbeef
`
    expect(diffLeavesNonV1Pin(diff, files)).toBe(true)
    expect(filterFollowUps(review.followUps, { diff, changedFiles: files })).toEqual(review.followUps)
  })

  it("omits the Follow-ups items that mention pins when the caller already uses @v1", () => {
    const text = renderDependenciesAndFollowUps(review, "", { diff: drip84Diff, changedFiles })
    expect(text).toContain("Add a changelog entry.")
    expect(text).not.toContain("TEST pin")
    expect(text).not.toContain("tool-ref")
  })
})

describe("renderGateLead from a derived change list", () => {
  it("renders the drip #84 example with symbol and file fallbacks", () => {
    const changes = deriveChangesFromDiff({ changedFiles, diff: drip84Diff, review })
    const text = renderGateLead(review, changes).join("\n")
    expect(text).toContain("### Summary")
    expect(text).toContain("### What this PR changes")
    expect(text).toContain("`lowestBalanceFrom` in `lib/maths.ts`")
    expect(text).toContain("`applyWithdraw` in `lib/maths.ts`")
    expect(text).toContain("`tests/gaps.test.ts`")
    expect(text).toContain("**Removed:** None")
    expect(text).toContain("lowestBalanceFrom was added")
    expect(text).toContain("applyWithdraw function")
    expect(text).not.toContain("runningBalancesUntilNextSet")
    expect(text).not.toContain("applyTopUp")
  })
})
