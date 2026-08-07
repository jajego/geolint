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
