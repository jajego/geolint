# Changelog

GeoLint follows [Semantic Versioning](https://semver.org/). Until the first stable release, `0.x` changes may refine public contracts and are documented here.

## Unreleased

### Added

- Structural GeoJSON validation with bounded recovery diagnostics.
- Built-in quality rules, delivery budgets, and source-aware checks.
- ESM Node API, CLI, typed plugin API, batch execution, and worker support.
- Schema-v1 regression baselines with full and partial snapshot updates.
- Pretty and schema-v1 JSON reporting.
- Deterministic benchmark and Semantic Conformance suites.
- Packed-package consumer verification and OSS quality guardrails.

Breaking public API, configuration, CLI, plugin, reporter, or persisted-schema changes require a major release once `1.0.0` is published. Backward-compatible functionality is minor; backward-compatible fixes are patch releases.
