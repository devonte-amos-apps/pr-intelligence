// Direct (level-0) dependency upgrade suggestions for PR Architecture Intelligence.
// Pure helpers are exported for unit tests; network access is injected.

export const KEY_FRAMEWORKS = new Set([
  "react",
  "react-dom",
  "next",
  "typescript",
  "prisma",
  "@prisma/client",
  "vitest",
  "@playwright/test",
  "eslint",
  "tailwindcss",
  "vite",
  "expo",
  "react-native",
  "node",
  "@types/node",
  "@types/react",
  "next-auth",
  "stripe",
  "zod",
]);

const KNOWN_RELEASE_NOTES = {
  react: "https://github.com/facebook/react/releases",
  "react-dom": "https://github.com/facebook/react/releases",
  next: "https://github.com/vercel/next.js/releases",
  typescript: "https://github.com/microsoft/TypeScript/releases",
  prisma: "https://github.com/prisma/prisma/releases",
  "@prisma/client": "https://github.com/prisma/prisma/releases",
  vitest: "https://github.com/vitest-dev/vitest/releases",
  "@playwright/test": "https://github.com/microsoft/playwright/releases",
  eslint: "https://github.com/eslint/eslint/releases",
  tailwindcss: "https://github.com/tailwindlabs/tailwindcss/releases",
  vite: "https://github.com/vitejs/vite/blob/main/packages/vite/CHANGELOG.md",
  expo: "https://expo.dev/changelog",
  "react-native": "https://github.com/facebook/react-native/releases",
};

const semverPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/;

export function parseVersion(value) {
  const match = semverPattern.exec(String(value || "").trim().replace(/^[v=^~]+/, ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
  };
}

export function classifyUpgrade(current, latest) {
  const from = parseVersion(current);
  const to = parseVersion(latest);
  if (!from || !to || to.prerelease) return "unknown";
  if (to.major !== from.major) return to.major > from.major ? "major" : "none";
  if (to.minor !== from.minor) return to.minor > from.minor ? "minor" : "none";
  if (to.patch !== from.patch) return to.patch > from.patch ? "patch" : "none";
  return "none";
}

export function directDependencies(packageJson) {
  const result = new Map();
  for (const [field, type] of [
    ["dependencies", "dependency"],
    ["devDependencies", "devDependency"],
  ]) {
    for (const [name, range] of Object.entries(packageJson?.[field] || {})) {
      if (!result.has(name)) result.set(name, { type, range: String(range) });
    }
  }
  return result;
}

export function parseOutdated(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function firstEntry(value) {
  // npm reports an array when a package is installed in several workspaces.
  return Array.isArray(value) ? value[0] : value;
}

function minimumFromRange(range) {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(range || "");
  return match ? match[1] : null;
}

/**
 * Build upgrade suggestions for direct dependencies only.
 * @returns {Array<{name,type,current,latest,kind,keyFramework,breakingRisk}>}
 */
export function buildUpgradeSuggestions(packageJson, outdated) {
  const direct = directDependencies(packageJson);
  const suggestions = [];
  for (const [name, rawInfo] of Object.entries(outdated || {})) {
    const meta = direct.get(name);
    const info = firstEntry(rawInfo);
    if (!meta || !info || typeof info !== "object") continue;
    const current = info.current || minimumFromRange(meta.range);
    const latest = info.latest;
    const kind = classifyUpgrade(current, latest);
    if (kind === "none" || kind === "unknown") continue;
    const keyFramework = KEY_FRAMEWORKS.has(name);
    suggestions.push({
      name,
      type: meta.type,
      current: current || "not installed",
      latest,
      kind,
      keyFramework,
      breakingRisk: kind === "major" && keyFramework,
    });
  }
  const order = { major: 0, minor: 1, patch: 2 };
  return suggestions.sort(
    (a, b) =>
      Number(b.breakingRisk) - Number(a.breakingRisk) ||
      order[a.kind] - order[b.kind] ||
      Number(b.keyFramework) - Number(a.keyFramework) ||
      a.name.localeCompare(b.name),
  );
}

export function repositoryReleaseUrl(repository) {
  const raw = typeof repository === "string" ? repository : repository?.url;
  if (!raw) return null;
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(raw);
  const match = shorthand || /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[#/].*)?$/.exec(raw);
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2].replace(/\.git$/, "")}/releases`;
}

export function npmVersionsUrl(name) {
  return `https://www.npmjs.com/package/${name}?activeTab=versions`;
}

/** Attach a release-notes link to each suggestion. `fetchImpl` is injectable for tests. */
export async function attachReleaseNotes(suggestions, { fetchImpl = globalThis.fetch, timeoutMs = 5_000 } = {}) {
  return Promise.all(
    suggestions.map(async (suggestion) => {
      let releaseNotes = KNOWN_RELEASE_NOTES[suggestion.name] || null;
      if (!releaseNotes && typeof fetchImpl === "function") {
        try {
          const response = await fetchImpl(
            `https://registry.npmjs.org/${suggestion.name.replace("/", "%2F")}/latest`,
            { signal: AbortSignal.timeout(timeoutMs) },
          );
          if (response?.ok) releaseNotes = repositoryReleaseUrl((await response.json())?.repository);
        } catch {
          // Network failures fall back to the npm versions page.
        }
      }
      return { ...suggestion, releaseNotes: releaseNotes || npmVersionsUrl(suggestion.name) };
    }),
  );
}

function kindLabel(suggestion) {
  if (suggestion.breakingRisk) return "🔴 major (key framework)";
  return { major: "🟠 major", minor: "🟡 minor", patch: "🟢 patch" }[suggestion.kind];
}

export function renderUpgradeTable(suggestions, { maxRows = 25 } = {}) {
  if (!suggestions || suggestions.length === 0) {
    return "## Dependency upgrade suggestions\n\nAll direct dependencies are on the latest stable release.\n";
  }
  const rows = suggestions
    .slice(0, maxRows)
    .map(
      (s) =>
        `| \`${s.name}\` | ${s.type === "devDependency" ? "dev" : "prod"} | ${s.current} | ${s.latest} | ${kindLabel(s)} | [notes](${s.releaseNotes || npmVersionsUrl(s.name)}) |`,
    )
    .join("\n");
  const majors = suggestions.filter((s) => s.breakingRisk).map((s) => `\`${s.name}\``);
  const more = suggestions.length > maxRows ? `\n\n_${suggestions.length - maxRows} more not shown._` : "";
  const callout = majors.length
    ? `> Major upgrades for key frameworks (${majors.join(", ")}) can be breaking. Read the release notes and upgrade them in a dedicated PR.\n\n`
    : "";
  return `## Dependency upgrade suggestions

${callout}| Package | Type | Installed | Latest stable | Upgrade | Release notes |
| --- | --- | --- | --- | --- | --- |
${rows}${more}
`;
}

export function upgradesForPrompt(suggestions) {
  return suggestions.map(({ name, current, latest, kind, keyFramework }) => ({
    name,
    current,
    latest,
    kind,
    keyFramework,
  }));
}
