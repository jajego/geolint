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
