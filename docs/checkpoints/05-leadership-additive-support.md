# Checkpoint 5 — Additive Leadership support

Status: complete on disposable databases on 2026-07-23.

Leadership now owns the versioned situation-bundle contract, scoped
visibility/ownership metadata, situation-scoped bindings, publisher
provenance, expected-generation validation/promotion/restore functions, and a
safe runtime release identity. Public readers resolve scoped variants only for
their owner and filter retired situations from routes and discovery output.

The migration is additive and the publisher role is function-mediated and
append-only. The reader role has SELECT only. Schema ownership, role
management, destructive history operations, and validation bypasses are not
granted.

A migration-parity test archives the clean Leadership baseline commit
`58e8634cb3901e55cf58bc17e9f3cac71d201f37`, applies only its baseline
migration, imports the production-shaped fixture, captures every legacy table,
applies the additive migration, and proves exact legacy-row and current-reader
parity. Leadership integration currently passes 13 tests.

Evidence:

- additive migration SHA-256:
  `209c0f3f97a643fcd1ff50833b6682f574aa493c02a560b17311a6281d9967ee`;
- grant SQL:
  `f3cb42612e7c4bb27edfbb519f4f5ee72b38a03f920b4a5c38a7185eb4b5b309`;
- role provisioning SQL:
  `b8741c0e2fe82d7e65a51b838953dee6151ffad45b4cba6326824bd4ffed6b73`;
- shared contract:
  `9cd3aeebb384edb2c1fb70647b55d0bbed147910216293fea2979d8eec7b17f4`.
