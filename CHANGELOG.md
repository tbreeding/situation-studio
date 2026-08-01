# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Changed automatic section-suggestion acceptance to reject additions, removals, or attribute changes to managed `PracticeEmbed` and `PreparedAction` tags; make those component edits explicitly in the raw MDX editor.
- Changed publication to fail closed for default new-situation drafts and scoped guide variants that content-contract 0.2.0 cannot yet represent as a valid canonical Leadership snapshot.

### Fixed

- Fixed publication validation so the exact assembled Leadership snapshot is checked before promotion, with safe actionable diagnostics and automatic restoration after an already-promoted restart failure.
