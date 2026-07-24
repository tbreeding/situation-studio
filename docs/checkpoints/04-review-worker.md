# Checkpoint 4 — Review worker and proposals

Status: deterministic route complete; live service qualification pending an
external credential.

The review worker implements the full durable 22-stage DAG with one global
running job and FIFO claiming. Jobs pin an immutable input revision and remain
read-only while queued or running. Cancellation and force-check-in fence late
work. Retry resumes at the first failed stage.

OpenAI Responses structured output is the primary service adapter. Anthropic
is an optional fallback. Both parse provider output through strict schemas and
record requested/resolved provider, model, reasoning effort, evidence/output
hashes, structured output, token usage, and failure classification. No adapter
can edit, publish, call tools, or access Leadership.

Deterministic integration tests execute all 22 stages in order and prove
durable evidence, one global runner, cancellation, proposal isolation, and
idempotent retries. A live service route was not invoked because no service API
credential is available. Personal Codex or Claude CLI authentication was not
used. Selecting a production model and completing this separately invoked
qualification remain pre-deployment inputs.
