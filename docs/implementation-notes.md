# Implementation notes

## Phase 0: ESM-only package output

V5 specifies an ESM-first distribution and CommonJS config-file compatibility,
not a CommonJS library export. The package therefore ships ESM only; config
loading support is deferred to Phase 1.

## Phase 1: Config loading and glob matching

V5 requires consistent TypeScript config support and a defined glob subset.
Config files load through Jiti, while tinyglobby enumeration and Picomatch
matching remain behind GeoLint-owned contracts. Their backend behavior is not
part of the public target syntax.

## Phase 1 hardening: stable resolution boundaries

Explicit targets resolve from invocation `cwd`; configured patterns resolve
from the config-defined project root. Raw config validation and `extends`
expansion happen before immutable per-file policy resolution. Stdin remains a
first-class target, with path overrides applied only when a logical filename is
provided.

## Phase 1 final hardening: glob and alias contracts

GeoLint validates its V1 glob subset before delegating to Picomatch or
tinyglobby. Configured patterns are enumerated together, and only literal
subtree ignores ending in `/**` are safe to prune during traversal; the normal
ignore matcher remains authoritative afterward. Static prefixes require exact
filesystem casing, while result casing is restored conservatively. File links
retain the logical path that selected them, directory links are not traversed,
and bounded `realpath` work deduplicates physical aliases before deterministic
path sorting.

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

`coordinate-precision` and `budget/feature-bytes` require numeric lexemes and
exact Feature spans from source input, which indexed execution provides.
Parsed-object input still fails capability preflight for those facts, and for
file-size budgets, because exact source bytes cannot be reconstructed. No
source values are approximated.

`meta.listensTo` is a rule's conservative maximum set of semantic traversal
events. It lets static planning derive scanner requirements without invoking
plugin code; `create()` still runs exactly once for each enabled rule and file
and may return any declared subset. Undeclared returned traversal hooks are
plugin-definition errors. Legacy V1 plugins without `listensTo` remain
supported and are planned conservatively.

`coordinateLexeme()` is the public capability boundary: declaring or returning
it requests positions and numeric lexemes automatically, while ordinary
`coordinate()` remains lexeme-free. Required aggregate facts remain in
`meta.requires`, narrow both their values and completeness statuses, and a
non-empty `requires` must have a `document()` consumer. Budget setting objects
reject fields other than `limit` and `severity`.

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

## Phase 6: indexed-source decisions

Semantic-only text remains on the buffered `JSON.parse` path. Numeric lexemes
or Feature spans select indexed-source enrichment over the shared iterative
JSON source cursor; file input can also select indexed execution under the
resource policy below. The CLI exposes `auto`, `buffered`, and `indexed`, with
`auto` as the intended default; public Node APIs select automatically. The
cursor validates the complete JSON grammar with an explicit container stack
before semantic dispatch, then replays only winning members. Coordinate arrays
remain source spans and are decoded one Position at a time through the shared
scanner; raw lexeme collections are created only when planned, and no
coordinate token tree or decoded coordinate graph is retained.

The V1 file and snapshot paths preserve a leading BOM. A BOM is therefore
visible to the JSON grammar and rejected like a leading U+FEFF passed directly
to `JSON.parse`; invalid byte sequences remain `parse/invalid-encoding`.
Indexed file lint uses a bounded byte window with byte-first UTF-8 and JSON
validation, then replays winning source spans through the same scanner. Auto
selects that path whenever source-only capabilities are needed, a file reaches
the 50 MiB internal large-file threshold, or the conservative file-byte check
for JavaScript string representation safety applies. The threshold prevents
excessive buffered amplification while smaller files remain on the faster
buffered path. `buffer.constants.MAX_STRING_LENGTH` is a JavaScript/V8 string
code-unit capacity, not a generic Node file-byte limit; comparing source file
bytes with it is a separate conservative safety check. Stdin remains the
existing in-memory path. Encoded Feature spans are half-open UTF-8 byte
ranges excluding collection separators and outer document whitespace. Timing
instrumentation separates complete syntax validation from the initial eager
index replay; later lazy replay is included in semantic traversal timing and
its replayed bytes/object counts remain explicit. Very large negative
coordinate exponents saturate reported effective decimals at
`Number.MAX_SAFE_INTEGER`, while threshold comparison remains correct.

The neutral JSON source cursor owns strict lexical structure, iterative nesting,
spans, and UTF-8 byte accounting for indexed lint. Buffered lint keeps
`JSON.parse` as its value and syntax authority, then uses a trusted-valid lexical
scan to recover decoded duplicate-member facts without revalidating scalar
grammar or allocating paths for ordinary values. Invalid JSON emits only
`parse/invalid-json`.

Indexed file execution removes the need to materialize the whole document as
one JavaScript string. A rule can still request an individual scalar or object
that exceeds JavaScript representation capacity; construction-time and lazy
materialization failures both produce `parse/source-too-large`.

## 0.1.7 file-execution resource policy

The three resource controls address different layers:

- **Representation policy (50 MiB):** `auto` selects indexed file execution at
  or above this source size to prevent severe per-file buffered amplification.
- **Concurrency policy (48 MiB):** the worker pool limits the total source bytes
  of simultaneously admitted buffered lint tasks. A single larger buffered
  task may run alone. This limits aggregate amplification but is not an RSS
  ceiling.
- **Worker lifecycle policy (10 MiB):** after a buffered task at or above this
  source size, a worker with pending work is replaced before another task.
  Benchmark sweeps showed that V8 worker isolates retained substantial
  committed heap after medium and large buffered parsing; replacement reduced
  accumulation across repeated waves with a small measured wall-time cost. It
  does not assert immediate operating-system memory reclamation.

These are internal resource-policy constants selected from benchmark sweeps
and may evolve as real-world corpus evidence improves. Representation governs
per-file memory behavior, concurrency governs simultaneous buffered memory,
and worker lifecycle governs retained heap between tasks.

## Terminal rendering boundary

Human-facing reporters escape source- and user-controlled terminal control
characters at the presentation boundary. Built-in prose uses JSON-style quoted
semantic values; structured JSON reporters preserve the original semantic data.
The explicit terminal-control list also includes bidi formatting controls that
could visually reorder report text; ordinary printable Unicode is unchanged.

## Phase 7: equivalence conformance decisions

The Semantic Conformance Suite uses one test-only differential harness: `JSON.parse` plus
object linting is the ordinary JSON oracle, then forced buffered and indexed
execution are compared without sorting emitted results. Ordinary projections
remove only timing and source-only fields unavailable to object input;
buffered/indexed source projections remain strict. Public hook traces are also
compared in emitted order.

Recursive member permutations use a fixed 32-bit `Math.imul` PRNG and preserve
array order. Failures include the fixture, seed, permutation, strategies, and a
bounded source reproduction. No property-testing dependency, shrinker, corpus
writer, or public testing API was added. The bounded Semantic Conformance Suite runs in
ordinary CI and separately through `npm run test:conformance`.

Phase 7 found no semantic divergence requiring production changes. The V5
stdin replay cases for memory replay, temp-file spooling, and cleanup on
success, parse failure, plugin failure, and abort remain deferred with the
underlying stdin/spooling feature. At the end of Phase 7, pathological semantic
GeometryCollection recursion remained a documented robustness limit; 0.1.3
later removed that limit with iterative semantic traversal.
