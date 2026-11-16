# PR Intelligence

Shared, reusable PR Architecture Intelligence review for personal and project repositories.

Each run collects the diff, `npm audit`, `npm ls`, tests, build and optional dependency-cruiser output, asks Gemini for a structured review against the **caller's own rules file**, and posts a sticky PR comment. It also adds a **Dependency upgrade suggestions** table for every direct (level-0) dependency: installed vs latest stable, patch/minor/major, with key-framework majors (React, Next.js, TypeScript, Prisma, Vitest, …) flagged and linked to release notes. The table is rendered even when Gemini is unavailable.

## Usage

```yaml
name: PR Architecture Intelligence
on:
  pull_request:
    types: [opened, synchronize, reopened]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    uses: devonte-amos-apps/pr-intelligence/.github/workflows/pr-architecture-intelligence.yml@v1
    with:
      rules-path: architecture-rules.json   # repo-specific principles and rules
      node-version: "22"
      dependency-cruiser-dirs: src          # optional, space-separated
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

Inputs: `rules-path`, `node-version`, `dependency-cruiser-dirs`, `extra-env` (non-secret build placeholders), `gemini-model`, `fail-on-high`, `fail-on-majors` (default `true`), `fail-on-high-findings`, `fail-on-area-fail`, `tool-ref`. Secret: `GEMINI_API_KEY` (optional; without it the comment still shows diagnostics and upgrade suggestions).

The rules file is JSON: `{ "project": "...", "reviewPrinciples": [...], "rules": [{ "id", "severity", "title", "description", "evidence" }] }`.

## PR intelligence gate

The workflow runs a second job, **PR intelligence gate**, that passes or fails the PR deterministically from the collected diagnostics, so it still works when Gemini is down or rate-limited.

| Rule | Default |
| --- | --- |
| npm audit has any high or critical vulnerability | fail |
| Review risk rated HIGH or CRITICAL (`fail-on-high`) | fail (skipped if the AI rating is unavailable) |
| dependency-cruiser requested and checked 0 modules, or reported errors > 0 | fail |
| PR introduces a major version bump (`fail-on-majors`, default `true`) | fail, unless the PR has the `allow-major-upgrade` label. Set `fail-on-majors: false` to opt the repository out. |
| Architecture finding with severity high or critical (`fail-on-high-findings`) | fail (medium and low stay advisory) |
| Review area with status Fail (`fail-on-area-fail`) | fail |
| Major upgrades available (npm outdated) | warning |

The gate writes a job summary and a sticky PR comment with a check table (`Check | Type | Outcome | Failure Trigger`), a data-derived **Why it failed** section, a **PR review breakdown**, a **Release suggestion** (semver patch/minor/major from the conventional title, labels, or branch name), a **Severity status** line (Clear when no high or critical blocking items remain), and a collapsible threshold matrix generated from the same policy object `evaluateGate` implements. High or critical findings are labelled **blocks gate**; medium and low stay **advisory**. After the gate runs, that comment is updated in place and consolidated with the architecture-review comment (markers `<!-- pr-intelligence-gate -->` and `<!-- pr-architecture-intelligence -->`) so reruns do not spam the thread.

When the gate passes, a separate sticky comment (marker `<!-- pr-intelligence-approval -->`) is posted or updated: `✅ PR intelligence: approved — severity clear, release: patch`. If a later run fails, that comment is updated to a not-approved status so a stale approval cannot linger. This is a comment only — the action does not submit a GitHub review approval and never merges the PR.

Create the `allow-major-upgrade` label in each consumer repository as a rollout step before relying on it to unblock a major-upgrade PR.

`tool-ref` (default `v1`) selects which pr-intelligence ref runs the scripts; keep it in step with the ref in `uses:`.

## Develop and test

Node 20+.

```bash
npm ci
npm test               # Vitest
npm run test:coverage  # Vitest with coverage
```

Releases are tagged (`v1.x.y`) and callers pin the moving major tag (`@v1`).

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
