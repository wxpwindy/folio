---
name: folio-aws-deployment
description: 'Use when planning, securing, deploying, or operating Folio on AWS, especially public invite-only hosting, SQLite/resume migration, AWS Agent Toolkit, ap-southeast-2, or a monthly cost cap.'
user-invocable: true
---

# Folio AWS Deployment

Use this skill for AWS work on Folio. Follow the project instructions in `AGENTS.md`; they take precedence over general AWS guidance.

## Confirmed Requirements

- The user chose public hosting with invite-only access and wants to include the existing SQLite database and resume files.
- The selected Region is `ap-southeast-2`; the stated monthly AWS budget ceiling is less than USD 100. Treat both as constraints, not estimates or permission to exceed them.
- This is the new AWS experience. Say project, team member, AWS Settings, and selected Region. Use the `default` AWS CLI profile when available; never ask for or expose credentials.
- The AWS Agent Toolkit service/catalog uses `us-east-1` per its setup instructions. This exception is limited to toolkit service calls; deploy Regional resources only in `ap-southeast-2`. CloudFront is global. Use `us-east-1` for WAF or CloudWatch Logs only when a global resource requires it.
- AWS CLI sign-in was verified for the managed `AccountFullAccessRole`. Credentials are short-lived. Recheck identity and expiration before operations; do not persist tokens or credentials.

## Security and Data Requirements

- Folio currently assumes loopback-only hosting. Its server binds to `127.0.0.1`, rejects non-loopback hosts, sets a non-`Secure` session cookie for loopback HTTP, and permits ordinary self-signup after the first setup-code-protected account. It is not public-ready.
- Do not expose the current app directly. Design and review explicit public host/origin handling, HTTPS, `Secure` cookies, trusted-proxy behavior, security headers, rate limits, and verified invite-only identity/account creation while preserving session, owner-scope, mutation-header, and stale-tab protections.
- Public hosting must not silently become public registration. Specify how invitations are created, delivered, redeemed, revoked, and recovered before implementing the flow.
- Resume PDFs, SQLite data, and session/account records are sensitive. Never upload them to a migration service or include them in code artifacts without separate, explicit data-transfer approval.
- For a SQLite transfer, stop writes or use SQLite's online backup API to create a consistent snapshot. Do not copy only the main database file while WAL writes may be active, and do not treat `-wal`/`-shm` sidecars as an independent backup. Encrypt storage and backups, restrict access, test restore, and preserve owner assignments.
- Keep local AI integrations local-only unless the user approves a specific remote provider and data flow. Do not open ports to LM Studio or Ollama.

## Deployment Workflow

1. Inspect the current code, tests, and infrastructure state; do not assume prior workspace or AWS configuration is unchanged.
2. Load the relevant current AWS service skills/docs before choosing services. If AWS MCP documentation tools are unavailable, say so and use available official documentation; do not claim a live architecture or price verification.
3. Identify the public DNS name/domain and TLS approach, invite lifecycle, application compute, persistent SQLite storage, backups, operations, and rollback path. A domain or certificate prerequisite must be resolved before public HTTPS deployment.
4. Present the target architecture and a monthly estimate with fixed and variable charges. Include data transfer, storage, logs, backups, certificates/domains, and any edge/security services. Do not promise the total stays below USD 100 without a verifiable estimate and usage assumptions. Use budget alerts; a budget alert is not a hard spend cap.
5. Get explicit approval for the proposed AWS resources and expected costs before provisioning. Keep Regional resources in `ap-southeast-2`; inspect CDK diff/CloudFormation changes before deployment.
6. Back up the existing database and resumes before migration. Validate the snapshot and restore procedure; never overwrite the source data. Ask whether to retain or clean up successfully created resources after deployment.
7. Validate HTTPS, invite-only access, session-cookie flags, API host/origin behavior, account isolation, SQLite persistence, backup restore, logs/alarms, and rollback. Run relevant project tests and report any gaps.

## Current Deployment Gates

- Public hosting, invite-only access, and migration of the existing SQLite data/resumes are approved goals, but that is not approval for an unreviewed architecture, source upload, or unbounded AWS charges.
- The user has not supplied a public domain/TLS hostname or a specific invitation workflow. Resolve those before implementation/deployment decisions that depend on them.
- The stated budget is a ceiling below USD 100/month, not an accepted estimate. Verify the AWS project plan and service availability before selecting services.
- The managed Launch with AWS workflow requires separate explicit approval to upload source code. It is not authorization to upload the database or resumes.
