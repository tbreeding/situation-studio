# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Changed agent review orchestration to keep one review focused through retry waits and terminal failures, pause later reviews until it succeeds or is explicitly stopped, and show safe stage-specific failure explanations.
- Changed automatic section-suggestion acceptance to reject additions, removals, or attribute changes to managed `PracticeEmbed` and `PreparedAction` tags; make those component edits explicitly in the raw MDX editor.
- Changed publication to fail closed for default new-situation drafts and scoped guide variants that content-contract 0.2.0 cannot yet represent as a valid canonical Leadership snapshot.

### Fixed

- Fixed proposal assembly so case-only differences in bundle-writer evidence links do not discard an otherwise complete review, and future assembly failures resume from the bundle writer with downstream audits rerun.
- Fixed publication validation so the exact assembled Leadership snapshot is checked before promotion, with safe actionable diagnostics and automatic restoration after an already-promoted restart failure.
