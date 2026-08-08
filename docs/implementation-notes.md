# Implementation notes

## Phase 0: ESM-only package output

V5 specifies an ESM-first distribution and CommonJS config-file compatibility,
not a CommonJS library export. The package therefore ships ESM only; config
loading support is deferred to Phase 1.

## Phase 1: Config loading and glob matching

V5 requires consistent TypeScript config support and a defined glob subset.
Config files load through Jiti, while Fast Glob and Picomatch are used only
behind GeoLint-owned loading and matching contracts. This keeps their behavior
out of the public API and permits replacement without changing user config.

## Phase 1 hardening: stable resolution boundaries

Explicit targets resolve from invocation `cwd`; configured patterns resolve
from the config-defined project root. Raw config validation and `extends`
expansion happen before immutable per-file policy resolution. Stdin remains a
first-class target, with path overrides applied only when a logical filename is
provided.

## Phase 1 final hardening: glob and alias contracts

GeoLint validates its V1 glob subset before delegating to Picomatch or Fast
Glob. Glob matching uses a discovered logical path; `realpath` is reserved for
later alias deduplication, so a file symlink remains eligible through the
configured path that selected it.

## Phase 2: buffered semantic decisions

V5 references `PropertyStats` without defining its shape. Phase 2 uses the
smallest data needed by the specified presence/type policies: `present`,
`missing`, and a coarse-type count map.

V5's `GeometrySummary.coordinateDimensions` union has no empty-geometry value.
An empty geometry therefore reports `"mixed"`, meaning no single observed
dimension category; document-level dimension counts remain all zero.

The object API follows the strict JSON-data-model boundary selected in the V5
review: `NaN` and positive or negative infinity are rejected with
`GEOLINT_INVALID_JSON_VALUE`, rather than entering structural traversal.

Object-API validation currently remains a separate walk before semantic
scanning. Fusing those walks is deferred until structural validation can do so
without weakening the input boundary or destabilizing the scanner.

## Phase 3: structural recovery decisions

Structural validation runs inside the semantic scanner. Coordinate arrays are
therefore inspected once for validation, enabled events, and requested facts.
LineStrings require at least two Positions; linear rings require at least four
Positions and identical first and last Positions. A structurally valid `bbox`
is a finite numeric array with an even length of at least four, supporting the
same 2D, 3D, and 4D+ dimensionality as Positions. GeoLint does not compare a
declared bbox with geometry-derived bounds.

Malformed Features, geometries, and Positions recover at their nearest safe
array boundary. Completed Geometry and Feature summaries are withheld whenever
their source subtree is incomplete, while safe observations remain available
through partial aggregate facts. The object API's strict JSON-model validation
remains a distinct boundary, so non-finite JavaScript numbers are input errors;
the string API has no raw-byte encoding state and therefore cannot emit
`parse/invalid-encoding`.

Partial property statistics use only Features with structurally interpretable
properties as their missing-count denominator. Invalid properties are unknown,
while an empty object or `null` is an observed missing state. Suppressed
diagnostics increment compact counters before display details are built, so
high-cardinality Position failures materialize paths only for retained
diagnostics. In a local 500k-invalid-Position run with a retention cap of two,
this reduced wall time from 256.4 ms to 106.2 ms while preserving all 500,000
logical errors.

## Phase 4: policy execution decisions

Enabled built-ins compile in the fixed registry order documented by the V1
catalog, independent of configuration member order. Bare budget shorthands use
`error`; byte strings are case-sensitive and accept only `B`, `KB`, `MB`, `GB`,
`KiB`, `MiB`, and `GiB`.

The recommended coordinate-range rule initially doubled the valid coordinate
hot-path time because the public coordinate hook requires an RFC 6901 path for
every Position. Built-in range and ID policies therefore use narrow internal
validated observations; public rule hooks retain their full event contracts.
Paths and diagnostic details are materialized only for retained findings.

`coordinate-precision` and `budget/feature-bytes` are registered and validated,
but fail capability preflight until indexed numeric lexemes and exact Feature
spans exist. Object-input file-size budgets likewise fail because exact source
bytes cannot be reconstructed. No source values are approximated.

`coordinateLexeme()` is the public capability boundary: subscribing requests
positions and numeric lexemes automatically, while ordinary `coordinate()`
remains lexeme-free. Required aggregate facts narrow both their values and
completeness statuses, and a non-empty `meta.requires` must have a `document()`
consumer. Budget setting objects reject fields other than `limit` and
`severity`.

The recommended ID rules currently keep separate duplicate-tracking sets in
the scanner aggregate and the local uniqueness rule. Sharing them would couple
public rule behavior to scanner state, so it remains deferred unless profiling
shows material memory pressure. Feature-vertex budget findings now use the
existing lazy diagnostic boundary, avoiding rich objects for suppressed
findings.

## Phase 5: regression and snapshot decisions

An absent baseline file is treated as an empty schema-v1 baseline during
ordinary lint, producing one explicit `no-baseline` skip for each enabled
comparison. Snapshot creates missing baseline parent directories. Numeric
thresholds have fixed error severity, use strict boundary comparisons, and
require both percentage and absolute conditions when both are configured.

Snapshot uses a fixed fact-rich scanner plan and never compiles rules, budgets,
plugins, or regression. Every target must produce complete file-byte,
Feature-count, vertex, property, geometry, and ID facts before the proposed
baseline is serialized. Replacement uses a flushed temporary file in the
destination directory followed by rename; failures before rename leave the
existing baseline untouched.

Schema version 1 counts every encoded Position, including Polygon closure
Positions. Changing that meaning, even without renaming `totalVertices`,
requires a schema-version bump. Baseline paths are project-root-relative,
case-preserving, `/`-normalized identities; no rename inference is attempted.

Persisted baseline entry keys use a platform-independent POSIX grammar and
must already be canonical: relative, `/`-separated, non-empty, non-traversing,
and free of dot segments. Filesystem resolution remains host-native. Baseline
parsing canonicalizes unordered summary maps before exact snapshot comparison.
The reader also rejects impossible count relationships: properties and IDs must
account for every Feature, geometry plus null counts must do the same, and
duplicate occurrences cannot exceed present ID occurrences minus one.
