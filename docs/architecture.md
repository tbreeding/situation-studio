# Architecture and trust boundaries

## Source-of-truth decision

Situation Studio uses hybrid authority. PostgreSQL owns mutable workflow, identity, durable jobs, review, and audit history. The protected Leadership Git repository owns every byte consumed by a public build. The live release marker identifies what users are receiving. A disagreement among PostgreSQL, protected `main`, and the live marker blocks publication and creates a reconciliation incident.

The public Leadership runtime remains independent of the Studio database.

## Service split

```text
Browser
  -> TimsPrototypes gate
  -> apps/web (session, CSRF, RBAC, JSON/UI)
       -> PostgreSQL with web role
       -> durable queues only

PostgreSQL queue
  -> apps/worker (conversation and review DAG)
       -> provider API adapters in evidence-only sandboxes

Approved immutable bundle
  -> apps/validator (clean disposable Leadership worktree; no deploy authority)
  -> apps/publisher (Git preview branch, release promotion, reconciliation; no AI/auth credential)
```

`packages/domain` has no Next.js, database, provider, Git, or deployment dependency. `packages/db` contains the reviewed schema and client only. Browser requests can select stable action identifiers; they cannot supply shell commands, provider models, paths, Git refs, or deployment targets.

## Credential matrix

| Service    |           Web DB |         AI DB | Publisher DB | passwords/sessions | provider secret |   Git push | release cutover |
| ---------- | ---------------: | ------------: | -----------: | -----------------: | --------------: | ---------: | --------------: |
| web        |              yes |            no |           no |                yes |              no |         no |              no |
| worker     |               no |           yes |           no |                 no |             yes |         no |              no |
| validator  | read-only bundle |            no |           no |                 no |              no | fetch only |              no |
| publisher  |               no |            no |          yes |                 no |              no |     scoped |          scoped |
| operations |    metadata only | metadata only |    reconcile |                 no |              no |      fetch |              no |
| migrator   |      schema only |   schema only |  schema only |      no body reads |              no |         no |              no |

Secrets live outside release directories in systemd credentials or mode-0600 files. No `NEXT_PUBLIC_*`, command argument, audit payload, structured log, or generated artifact may contain one.

## Provider policy decision

The consumer CLI design from the input spec is disabled for external beta use. Current OpenAI consumer guidance treats an account as individual and current Terms prohibit programmatic extraction from individual services; Anthropic's published surface guidance directs automated pipelines and production applications to the API. The production boundary therefore requires OpenAI Responses API and Anthropic API/service credentials. Local/RP1 CLI adapters may be qualification fixtures only and cannot be enabled for invited users.

The model policy remains `gpt-5.6-sol` and the current Opus family, with resolved model IDs, policy version, reasoning effort, usage, and fallback persisted for every run.

## Security invariants

- AI identities cannot hold `publication.approve` or `publication.publish`.
- all content/workflow mutations require checkout ID and current fencing token.
- shared resource sets acquire atomically in sorted order or not at all.
- approved bundles are immutable and content addressed.
- provider subprocesses receive only an evidence packet and schema; they receive no live repository, database, provider-management, Git, or deployment capability.
- the publisher accepts only a non-invalidated human approval over the exact bundle/base/validation hashes.
- draft MDX is parsed to an inert allowlisted representation and never executed.
