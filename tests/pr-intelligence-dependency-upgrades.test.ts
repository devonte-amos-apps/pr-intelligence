import { describe, expect, it, vi } from "vitest"

import {
  attachReleaseNotes,
  buildUpgradeSuggestions,
  classifyUpgrade,
  directDependencies,
  npmVersionsUrl,
  parseOutdated,
  parseVersion,
  renderUpgradeTable,
  repositoryReleaseUrl,
  upgradesForPrompt,
} from "../scripts/pr-intelligence/dependency-upgrades.mjs"

const packageJson = {
  dependencies: { react: "^18.3.1", next: "15.0.0", zod: "^3.22.0", lodash: "^4.17.20" },
  devDependencies: { typescript: "~5.4.0", vitest: "^4.1.5", "left-pad": "^1.0.0" },
}

describe("dependency upgrade suggestions", () => {
  it("parses versions and rejects junk", () => {
    expect(parseVersion("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null })
    expect(parseVersion("^2.0.0-beta.1")?.prerelease).toBe("beta.1")
    expect(parseVersion("latest")).toBeNull()
    expect(parseVersion(undefined)).toBeNull()
  })

  it("classifies patch, minor, major and non-upgrades", () => {
    expect(classifyUpgrade("1.2.3", "1.2.4")).toBe("patch")
    expect(classifyUpgrade("1.2.3", "1.3.0")).toBe("minor")
    expect(classifyUpgrade("1.2.3", "2.0.0")).toBe("major")
    expect(classifyUpgrade("1.2.3", "1.2.3")).toBe("none")
    expect(classifyUpgrade("2.0.0", "1.9.9")).toBe("none")
    expect(classifyUpgrade("1.3.0", "1.2.9")).toBe("none")
    expect(classifyUpgrade("1.2.4", "1.2.3")).toBe("none")
    expect(classifyUpgrade("1.2.3", "2.0.0-rc.1")).toBe("unknown")
    expect(classifyUpgrade("git+ssh", "1.0.0")).toBe("unknown")
  })

  it("collects direct deps and devDeps once", () => {
    const direct = directDependencies({ dependencies: { a: "1" }, devDependencies: { a: "2", b: "3" } })
    expect(direct.get("a")).toEqual({ type: "dependency", range: "1" })
    expect(direct.get("b")?.type).toBe("devDependency")
    expect(directDependencies(undefined).size).toBe(0)
  })

  it("tolerates empty or invalid npm outdated output", () => {
    expect(parseOutdated("")).toEqual({})
    expect(parseOutdated("not json")).toEqual({})
    expect(parseOutdated("[]")).toEqual({})
    expect(parseOutdated('{"a":{"latest":"1.0.0"}}')).toEqual({ a: { latest: "1.0.0" } })
  })

  it("builds sorted suggestions for direct dependencies only and flags key-framework majors", () => {
    const outdated = {
      react: { current: "18.3.1", wanted: "18.3.1", latest: "19.2.0" },
      lodash: { current: "4.17.20", latest: "4.17.21" },
      zod: [{ current: "3.22.0", latest: "3.25.0" }],
      typescript: { latest: "6.0.2" },
      "left-pad": { current: "1.0.0", latest: "2.0.0" },
      vitest: { current: "4.1.5", latest: "4.1.5" },
      transitive: { current: "1.0.0", latest: "9.0.0" },
      broken: null,
    }
    const suggestions = buildUpgradeSuggestions(packageJson, outdated)
    expect(suggestions.map((s) => s.name)).toEqual(["react", "typescript", "left-pad", "zod", "lodash"])
    expect(suggestions[0]).toMatchObject({ kind: "major", breakingRisk: true, type: "dependency" })
    expect(suggestions[1]).toMatchObject({ current: "5.4.0", type: "devDependency" })
    expect(suggestions.find((s) => s.name === "left-pad")).toMatchObject({ kind: "major", breakingRisk: false })
    expect(buildUpgradeSuggestions(packageJson, undefined)).toEqual([])
    expect(
      buildUpgradeSuggestions({ dependencies: { x: "github:a/b" } }, { x: { latest: "1.0.0" } }),
    ).toEqual([])
  })

  it("derives GitHub release URLs from registry repository fields", () => {
    expect(repositoryReleaseUrl("git+https://github.com/colinhacks/zod.git")).toBe(
      "https://github.com/colinhacks/zod/releases",
    )
    expect(repositoryReleaseUrl({ url: "git@github.com:lodash/lodash.git" })).toBe(
      "https://github.com/lodash/lodash/releases",
    )
    expect(repositoryReleaseUrl("github:owner/pkg")).toBe("https://github.com/owner/pkg/releases")
    expect(repositoryReleaseUrl("https://gitlab.com/a/b")).toBeNull()
    expect(repositoryReleaseUrl(undefined)).toBeNull()
  })

  it("attaches known, registry-derived and fallback release notes", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("zod")) {
        return { ok: true, json: async () => ({ repository: { url: "git+https://github.com/colinhacks/zod.git" } }) }
      }
      if (url.includes("boom")) throw new Error("offline")
      return { ok: false, json: async () => ({}) }
    })
    const result = await attachReleaseNotes(
      [{ name: "react" }, { name: "zod" }, { name: "@scope/missing" }, { name: "boom" }] as never,
      { fetchImpl },
    )
    expect(result.map((r) => r.releaseNotes)).toEqual([
      "https://github.com/facebook/react/releases",
      "https://github.com/colinhacks/zod/releases",
      npmVersionsUrl("@scope/missing"),
      npmVersionsUrl("boom"),
    ])
    expect(fetchImpl).toHaveBeenCalledWith("https://registry.npmjs.org/@scope%2Fmissing/latest", expect.anything())
    const offline = await attachReleaseNotes([{ name: "zod" }] as never, { fetchImpl: null as never })
    expect(offline[0].releaseNotes).toBe(npmVersionsUrl("zod"))
  })

  it("renders a table with a breaking-change callout and row cap", () => {
    const rows = [
      { name: "react", type: "dependency", current: "18.3.1", latest: "19.2.0", kind: "major", keyFramework: true, breakingRisk: true, releaseNotes: "https://x/react" },
      { name: "a", type: "devDependency", current: "1.0.0", latest: "2.0.0", kind: "major", keyFramework: false, breakingRisk: false },
      { name: "b", type: "dependency", current: "1.0.0", latest: "1.1.0", kind: "minor", keyFramework: false, breakingRisk: false, releaseNotes: "https://x/b" },
      { name: "c", type: "dependency", current: "1.0.0", latest: "1.0.1", kind: "patch", keyFramework: false, breakingRisk: false, releaseNotes: "https://x/c" },
    ]
    const markdown = renderUpgradeTable(rows, { maxRows: 3 })
    expect(markdown).toContain("## Dependency upgrade suggestions")
    expect(markdown).toContain("(`react`)")
    expect(markdown).toContain("| `react` | prod | 18.3.1 | 19.2.0 | 🔴 major (key framework) | [notes](https://x/react) |")
    expect(markdown).toContain("| `a` | dev | 1.0.0 | 2.0.0 | 🟠 major | [notes](" + npmVersionsUrl("a") + ") |")
    expect(markdown).toContain("🟡 minor")
    expect(markdown).not.toContain("`c`")
    expect(markdown).toContain("1 more not shown")
    expect(renderUpgradeTable([])).toContain("latest stable release")
    expect(renderUpgradeTable([rows[3]])).not.toContain("can be breaking")
    expect(upgradesForPrompt(rows as never)[0]).toEqual({ name: "react", current: "18.3.1", latest: "19.2.0", kind: "major", keyFramework: true })
  })
})
