# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report it privately through GitHub: go to this repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting / security advisories). Include:

- what is affected (URL, route, file or workflow),
- steps to reproduce or a proof of concept,
- the impact you expect.

You should get an acknowledgement within 7 days. Please give a reasonable window for a fix before any public disclosure.

## Supported versions

Only the latest `main` branch (and the deployment built from it) receives security fixes.

## Scope

In scope: this repository's code, dependencies and GitHub Actions workflows (including the reusable workflow and composite action called by other repositories). Out of scope: denial-of-service volume testing, social engineering, and third-party services (e.g. Vercel, GitHub, Google) themselves.
