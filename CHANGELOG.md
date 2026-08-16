# Changelog

GeoLint follows [Semantic Versioning](https://semver.org/). Until the first stable release, `0.x` changes may refine public contracts and are documented here.

## 0.1.5 - 2026-08-16

### Added

- Add optional `regression.requireBaseline` coverage for CI workflows that require every regression-governed artifact to have approved baseline state.

### Changed

- Clarify artifact-baseline, snapshot, permissive, and strict CI workflows. Missing baseline entries continue to produce visible skips by default.
- Identify the baseline file written by `geolint snapshot`.

## 0.1.4 - 2026-08-16

### Changed

- Expose existing `lintFiles()` worker configuration through the public TypeScript API.
- Expand plugin-author guidance for lifecycle, options, aggregate rules, source-aware rules, workers, testing, and packaging.

### Internal

- Strengthen packed external-plugin and worker integration coverage.

## 0.1.3 - 2026-08-16

### Changed

- Reduced buffered source-lint overhead while preserving unconditional duplicate JSON key diagnostics.
- Reduced cold CLI startup by routing `--version` and `--help` before the lint subsystem loads, and loading `jiti` only for JavaScript or TypeScript configuration.
- Made already-parsed JSON-value validation iterative so deeply nested input does not exhaust the JavaScript call stack.
- Made GeometryCollection semantic traversal stack-safe for deeply nested valid GeoJSON.
- Improved `lintGeoJSON()` performance for large parsed GeoJSON values.

## 0.1.2 - 2026-08-15

### Added

- Report duplicate JSON object keys from text and file input with the later key's JSON Pointer and UTF-8 byte offset.

### Fixed

- Escape control characters in human-readable diagnostic, path, filename, and snapshot output.
- Harden human-readable rule identifiers against terminal controls and Unicode bidi formatting controls.

### Changed

- Improved target discovery for large, deep, wide, and overlapping file sets without changing discovery semantics.

## 0.1.1 - 2026-08-10

### Changed

- Made Feature IDs and uniform geometry types opt-in policies in `geolint/web`.
- Added observed and configured values to coordinate-precision and artifact-budget diagnostics.
- Improved threshold regression diagnostics with percentage and approved/current values.
- Improved property-type and null-geometry regression diagnostics with approved → current values.
- Improved missing- and duplicate-ID regression diagnostics with approved → current counts.

### Documentation

- Clarified the cost of source-aware policies on large coordinate-heavy files.

## 0.1.0 - 2026-08-10

### Added

- Structural GeoJSON validation with bounded recovery diagnostics.
- Built-in quality rules, delivery budgets, and source-aware checks.
- ESM Node API, CLI, typed plugin API, batch execution, and worker support.
- Schema-v1 regression baselines with full and partial snapshot updates.
- Pretty and schema-v1 JSON reporting.
- Deterministic benchmark and Semantic Conformance suites.
- Packed-package consumer verification and OSS quality guardrails.

Breaking public API, configuration, CLI, plugin, reporter, or persisted-schema changes require a major release once `1.0.0` is published. Backward-compatible functionality is minor; backward-compatible fixes are patch releases.
