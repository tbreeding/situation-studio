# Checkpoint 4 — Review worker and proposals

Status: deterministic route and live Codex subscription route complete; the
Claude fallback must be reauthenticated and smoke-tested under the dedicated
production review user.

The review worker implements the full durable 22-stage DAG with one global
running job and FIFO claiming. Jobs pin an immutable input revision and remain
read-only while queued or running. Cancellation and force-check-in fence late
work. Retry resumes at the first failed stage.

Pinned subscription CLIs are the production adapters: Codex first and Claude
fallback. They parse output through strict schemas and record
requested/resolved provider, model, reasoning effort, evidence/output hashes,
structured output, token usage, and failure classification. Child processes
receive no Studio database, session, publisher, backup, or Leadership
credentials. Claude tools are disabled. Codex ignores user/project
configuration and rules, runs ephemerally in a temporary read-only sandbox,
and receives a stripped tool-command environment.

Deterministic integration tests execute all 22 stages in order and prove
durable evidence, one global runner, cancellation, proposal isolation, and
idempotent retries. Adapter tests prove Codex-first ordering, Claude fallback,
secret-minimal child environments, strict output validation, and rejection of
secret-shaped output. A live Codex wrapper smoke used ChatGPT subscription
authentication with `gpt-5.6-sol` and returned valid structured output. The
local Claude OAuth session was expired; production setup therefore requires
device/browser authentication and one no-tools smoke under the isolated review
user before the deployment preflight.
