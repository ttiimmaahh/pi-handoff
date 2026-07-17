# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-07-17

### Fixed

- Route handoff generation through a registered extension provider's `streamSimple` implementation, so custom APIs such as `sap-aicore-orchestration` can generate summaries under Pi 0.80.9–0.80.x.
- Forward provider-scoped environment values when generating handoffs.

## [0.1.0] - 2026-06-06

### Added

- Initial public release on npm: `pi install npm:@ttiimmaahh/pi-handoff`.
- Proactive handoff generation when context usage crosses a configured percent or token threshold.
- `/handoff-setup`, `/handoff`, and `/handoff-load` commands.
- Optional structured replacement for Pi's `/compact` summaries.
- Environment overrides for model, threshold, compaction behavior, handoff path, config path, and debug logging.
- CI, Trusted Publishing workflow, MIT license, and npm package metadata.

[Unreleased]: https://github.com/ttiimmaahh/pi-handoff/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/ttiimmaahh/pi-handoff/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/ttiimmaahh/pi-handoff/releases/tag/v0.1.0
