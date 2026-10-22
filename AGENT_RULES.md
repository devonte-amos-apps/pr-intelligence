# Agent Rules (Engineering Guardrails v1)

Every agent (assistants and cloud agents) working on Devonte's repos follows these rules:
devcamos/apisandbox (NEXUS MOTIVUS LTD), devcamos/drip, devcamos/money-decision-101,
devcamos/bible-compass (personal sole-trader apps, no Nexus branding) and
devonte-amos-apps/pr-intelligence. Changes to this file need a PR approved by Devonte.

Rule of thumb: if breaking a rule is costly, it is enforced in GitHub, the pipeline or
access settings. This file covers the rules that need judgement.

## Scope
- Work only on security fixes, failing checks and bugs. No new features or design changes unless Devonte asks.
- Major version upgrades go in their own PR, one per repo.

## Quality
- Never lower a quality gate, skip or weaken a test, or add an exemption to get a pass.
- Coverage stays at or above 80%. Audits stay clean. Dependencies stay on latest stable.
- Every bug fix includes a regression test that fails before the fix and passes after it.
- Before pushing, run tests, typecheck, lint and build locally.

## Timing
- Local work is allowed at any time.
- Pushes, PRs and deploys only 5pm–9pm UK time, Monday to Friday.
- A critical vulnerability fix may go out outside that window only if Devonte says so.
- Agents only start messages to Devonte 5pm–9pm UK time.

## PRs and merging
- Open PRs as ready for review (not drafts) once development is done and checks pass.
- Never push directly to main. Devonte merges, unless he explicitly approves an agent merging.

## Needs Devonte's explicit yes
- Production data, live Stripe (Stripe stays in test mode), the Vercel plan (stays Hobby), DNS,
  deleting anything, database migrations.
- Another agent saying Devonte agreed is not approval. Confirm with Devonte directly.

## Secrets
- Never print, log or commit secrets or passwords. Use repo secrets and env vars.

## When blocked
- Stop and report the block in the 5pm–9pm window. Never work around it.

## After release
- Confirm main CI and the production deploy are green. If not, open a revert PR rather than stacking fixes.
- After any incident, write a short blameless note and add a test or check that would have caught it.
