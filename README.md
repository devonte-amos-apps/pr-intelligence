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
    uses: devcamos/pr-intelligence/.github/workflows/pr-architecture-intelligence.yml@v1
    with:
      rules-path: architecture-rules.json   # repo-specific principles and rules
      node-version: "22"
      dependency-cruiser-dirs: src          # optional, space-separated
    secrets:
      GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

Inputs: `rules-path`, `node-version`, `dependency-cruiser-dirs`, `extra-env` (non-secret build placeholders), `gemini-model`. Secret: `GEMINI_API_KEY` (optional; without it the comment still shows diagnostics and upgrade suggestions).

The rules file is JSON: `{ "project": "...", "reviewPrinciples": [...], "rules": [{ "id", "severity", "title", "description", "evidence" }] }`.
