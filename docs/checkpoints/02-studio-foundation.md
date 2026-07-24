# Checkpoint 2 — Studio foundation

Status: complete locally on 2026-07-23.

Implemented the independent `situation_studio` schema, checked-in migrations,
opaque revocable sessions, Argon2id passwords, login throttling, CSRF and
origin checks, `EDITOR`/`ADMIN` authorization, read-only Leadership bootstrap,
durable checkouts and fencing, immutable revisions, check-in, resume, start
over, force-check-in, and audit history.

Database constraints enforce one active checkout per situation, immutable
history tables, revision ordering, and fenced ownership. Integration tests
prove one winner under concurrent checkout, checkout survival beyond 31
minutes, exact draft persistence and resume, force-check-in cancellation, and
rejection of stale saves. Browser tests prove no public signup, safe return
destinations, generic throttling errors, deactivation/session revocation, and
admin route denial.

All work used disposable PostgreSQL 16 databases. No production role or
database was accessed.
