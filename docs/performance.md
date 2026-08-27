# GeoLint performance

GeoLint's benchmark suite measures product linting, parser strategies, source-aware policies, hostile inputs, diagnostic floods, sequential batches, cold CLI startup, and isolated peak process memory. Timing comparisons are advisory; correctness and traversal invariants fail the benchmark command.

## Commands

```sh
npm run benchmark
npm run benchmark:extended
npm run benchmark:json
npm run benchmark:cli
npm run benchmark:large-memory
npm run benchmark:compare -- baseline.json current.json 20
```

The standard suite is the normal development and CI check. The extended suite adds dedicated child-process peak-RSS measurements. Either suite accepts `--output benchmark-results/name.json`; generated JSON artifacts are ignored by Git. CI writes the standard artifact and uploads it from the Ubuntu job.

`npm run benchmark:large-memory` is opt-in and is not part of normal CI. It streams deterministic temporary fixtures: dense coordinate Lines at roughly 10, 50, and 100 MiB; roughly 50 MiB of many small Features; and a roughly 50 MiB large-property-string control. Buffered and production-indexed runs each use a fresh child process per sample, so max RSS is not contaminated by another strategy. Indexed file parsing retains one fixed byte window and re-reads winning spans as needed; it does not retain the complete source buffer. The suite uses two 10 MiB samples and one sample for each larger case to keep the command practical; it cleans its temporary directory in a `finally` block. Expect roughly 260 MiB of temporary disk space and substantial RAM pressure for the dense buffered cases. Use `-- --output benchmark-results/large.json` to retain an artifact, then compare same-machine artifacts with `benchmark:compare`. Absolute timings and RSS are not comparable across different machines or Node majors.

## Execution strategies

`auto` is the default and recommended file strategy. It keeps ordinary files below the internal 50 MiB policy threshold on the faster buffered path, and selects indexed execution for larger files, source-aware requirements such as coordinate numeric lexemes, or conservative JavaScript string-representation safety. The threshold limits buffered amplification observed on large and dense inputs; it is not a universal physical safety limit.

Buffered execution decodes the file into a JavaScript string, uses `JSON.parse`, scans duplicate keys, and performs semantic traversal. It is generally the fastest path for ordinary files, but the source string and parsed object graph can produce high memory amplification on large or dense input.

Indexed file execution reads through a bounded byte window and re-reads winning spans as needed instead of retaining the complete source buffer or source string. Its file-source representation is more memory-stable but generally slower, and semantic state still depends on the document and enabled policy; this is not a constant-memory guarantee. An individual JSON value requested by a rule may still exceed JavaScript string capacity, in which case GeoLint reports `parse/source-too-large`.

For eligible parallel batches, GeoLint limits the aggregate source bytes admitted to buffered workers and refreshes workers after sufficiently large buffered tasks. These controls reduce simultaneous buffered amplification and retained worker heap between tasks; they do not promise a fixed RSS ceiling or immediate memory reclamation.

## Methodology

Fixtures are deterministic and generated before timed regions. Member-order randomization uses a fixed seed. Every warm in-process case, including indexed detail, buffered detail, and multi-rule traversal instrumentation, runs one complete discarded warmup before fresh per-sample instrumentation is collected. Inputs of at least 5 MB use three measured samples and smaller inputs use five; the median is primary. Fixture byte counts are computed before timing.

Cold-start cases launch a fresh built CLI process for each of five samples. They separately measure `--version`, `--help`, and a small clean JSON lint. They are not compared with warm engine throughput.

`npm run benchmark:cli` is the focused cold-process check. It runs seven measured child processes (after two warmups) for metadata commands, tiny no-config/configured files, a nested no-config discovery path, and small/large file controls.

Peak RSS cases each run in a dedicated child process and report the larger of Node's process RSS and `resourceUsage().maxRSS`. The measurement includes the source text and fixture representation resident in that process. It is not a constant-memory claim and is not directly comparable across operating systems.

Throughput uses actual result Features and vertices. Indexed detail cases retain syntax-validation, initial-index-replay, semantic-replay, object/span, replayed-byte, traversal, Position-visit, and path-materialization instrumentation. Coordinate-heavy and object-heavy buffered detail cases separately measure `JSON.parse`, duplicate-key source scanning, semantic scanning, and total buffered execution.

## Artifact schema

Benchmark artifacts use schema version 1 independently of package semver:

```json
{
  "schemaVersion": 1,
  "geolintVersion": "1.0.0",
  "suite": "standard",
  "environment": {
    "node": "v26.5.1",
    "platform": "win32",
    "arch": "x64",
    "cpuModel": "...",
    "logicalCpuCount": 8,
    "totalMemoryBytes": 123
  },
  "cases": []
}
```

Each case records its stable ID, group, fixture, policy profile, parser strategy, source bytes, raw timing samples, median/min/max, applicable throughput, semantic counts, optional instrumentation, and optional peak RSS.

The comparison command validates schema version 1 and the required artifact, environment, and case fields before comparison. It matches stable case IDs only when fixture, profile, strategy, source bytes, and present semantic counts also match. Added, removed, and changed cases are listed without timing deltas. Timing comparison requires matching platform, architecture, Node major version, and CPU model (with whitespace normalized); logical CPU-count differences and material system-memory differences are warnings. Its default 20% threshold is explicit and advisory, and it never fails normal CI solely for timing variance.

## Fixtures and profiles

The suite covers 10k/100k/1m points, LineString, Polygon, nested mixed GeometryCollections, one huge Feature, many tiny Features, wide/sparse/mixed properties, canonical/fixed-seed random member order, losing/winning huge duplicate coordinates, minified/pretty source, and high-cardinality failures. Public parsed-object profiles run `lintGeoJSON()` against 100k/1m coordinates, 100k Features, and wide properties; fixture construction is outside the timed region so they guard arbitrary-JavaScript validation plus semantic linting.

Named profiles are `structural`, `recommended`, `source-precision`, `source-feature-bytes`, `source-combined`, `regression`, `snapshot-facts`, and `high-cardinality-failure`. A three-plugin-coordinate-hook case measures dispatch while asserting one coordinate traversal and exactly three callbacks per Position.

## Single-threaded performance

Measurements below were collected on Node v26.5.1, Windows x64, an Intel i9-9900K. They characterize this machine only.

| Case                                          |     Median |
| --------------------------------------------- | ---------: |
| recommended 100k points                       |    21.8 ms |
| recommended 1m points                         |   292.6 ms |
| source precision 100k                         |   145.8 ms |
| source precision 1m                           | 1,408.2 ms |
| Feature-byte budget, huge 100k-vertex Feature |   146.4 ms |
| combined source policy, 10k Features          |   115.2 ms |
| many tiny Features, 100k                      |   279.8 ms |
| wide properties, 10k keys                     |    12.2 ms |
| sparse properties, 10k Features               |    28.3 ms |
| mixed property types, 10k Features            |    24.6 ms |
| hostile losing duplicate, indexed detail      |    41.8 ms |
| 100k coordinate failures                      |    27.1 ms |
| CLI small lint cold start                     |   163.7 ms |
| regression batch, 10 medium files             |    38.3 ms |
| regression batch, 100 small files             |    75.6 ms |

Buffered versus indexed semantic-only medians were 3.4/16.6 ms at 10k, 23.4/111.8 ms at 100k, and 281.8/1,085.8 ms at 1m. There is no measured crossover for the faster semantic-only path; automatic file selection retains buffered `JSON.parse` below the large-file threshold unless exact source capabilities require indexed execution.

At 100k points, buffered detail measured 24.6 ms total: 5.9 ms in `JSON.parse`, 8.5 ms in the duplicate-key source scan (`duplicateKeyScanMs`), and 10.3 ms in semantic scanning. The object-heavy 100k-Feature detail case measured 228.3 ms total: 62.6 ms parsing, 112.3 ms duplicate scanning, and 52.6 ms semantic scanning. Indexed attribution at 100k points was 25.6 ms syntax validation, 15.9 ms initial index replay, and 87.7 ms semantic/lazy replay. Source precision performs required numeric-token decoding and decimal analysis, so its 145.8 ms versus recommended's 21.8 ms is not described as parser-only overhead.

The losing duplicate case replayed and syntax-validated 928,971 source bytes but visited exactly one winning Position. The winning duplicate visited 100,000 Positions and took 130.2 ms versus 41.8 ms for the losing case. Both used one coordinate traversal and materialized no coordinate paths.

Fixed-seed randomized member order measured 29.0 ms versus 26.7 ms canonical. Pretty source was 3,328,961 bytes and 178.9 ms versus minified's 928,949 bytes and 151.7 ms; byte throughput was higher for pretty input because whitespace is cheap.

Many tiny Features were roughly 12.1 times slower than one huge Feature at the same 100k coordinate volume, reflecting Feature lifecycle, ID/property, summary, and path work. GeometryCollection-heavy 10k-position input measured 8.5 ms. Wide, sparse, and mixed-property workloads measured 12.2, 28.3, and 24.6 ms respectively.

Diagnostic floods remained bounded: 100k coordinate failures retained 2 diagnostics and suppressed 99,998; 10k missing IDs retained 2 and suppressed 9,998; 9,999 duplicate-ID findings retained 2; and 10k Feature-budget findings retained 2.

Sequential regression throughput was 261.0 files/s for 10 medium files and 1,323.5 files/s for 100 small files. These are the single-threaded reference measurements.

Peak RSS measured 55.2 MiB at 10k buffered points, 73.9 MiB at 100k, and 257.0 MiB at 1m. Indexed semantic-only 1m peaked at 162.3 MiB and indexed source-precision at 163.5 MiB, but both were much slower. A huge 100k-vertex Feature peaked at 80.6 MiB, 100k tiny Features at 185.0 MiB, and the indexed losing duplicate at 66.3 MiB. These measurements show input- and policy-dependent growth, not an asymptotic guarantee.

## Profiling and optimization

CPU profiles were collected for recommended and source-aware 1m points, many tiny Features, wide/sparse properties, diagnostic floods, and the losing duplicate. Ordinary lint was dominated by native `JSON.parse`, duplicate-key source scanning, garbage collection, and coordinate scanning. Source-aware lint was dominated by indexed number decoding, coordinate value materialization, and required decimal analysis. Wide/sparse cases concentrated in property scanning/stat completion; bounded diagnostic retention did not dominate flood workloads. The losing duplicate spent time in syntax/index token handling, not semantic traversal.

The many-Feature profile identified repeated JSON Pointer escaping for numeric Feature indices. The retained optimization returns numeric segments directly and skips replacements for strings without `~` or `/`.

The buffered duplicate-source profile identified redundant grammar validation, path allocation, UTF-8 accounting, and per-object allocation after native parsing. The trusted-valid scanner reduced focused duplicate-scan medians from 31.3 to 9.4 ms for 100k coordinates and from 246.7 to 120.6 ms for 100k tiny Features; focused total buffered medians fell from 41.2 to 27.4 ms and from 343.8 to 223.5 ms respectively.

The subsequent structural scanner retains the same trusted-valid contract but visits only JSON container punctuation, strings, and object keys. It preserves duplicate paths and byte offsets without re-walking scalar grammar. Release-to-release measurements found 19–24% lower public source-lint latency than 0.1.2 on large coordinate-, Feature-, and property-heavy fixtures, with unchanged peak RSS on the measured 1m-coordinate and 100k-Feature cases.

Indexed coordinate traversal now uses a direct low-allocation path when numeric lexemes are not required, while source-aware numeric-lexeme workloads retain the generic indexed traversal. The optimization preserves the existing indexed representation and semantic scanner.

## CLI bootstrap

The CLI entry parses arguments before loading the full command implementation. `--help` returns from shared help text, and `--version` reads the authoritative package version, without importing the lint engine, reporters, target discovery, or configuration runtime. Lint commands then cross one lazy boundary into the existing CLI implementation. `jiti` is loaded only when a JavaScript or TypeScript config actually needs execution; JSON and no-config runs do not initialize it.

## Target discovery

Target discovery uses tinyglobby behind GeoLint's existing target contract. Configured patterns are enumerated together, safe project-root ignores prune traversal, and identical logical paths collapse before policy and physical-identity work. GeoLint then applies authoritative ignore and override matching, validates path casing, resolves physical identities with bounded concurrency, reduces aliases deterministically, and returns sorted targets. File links retain their logical names; directory links are not traversed.

Run `npm run benchmark:targets` for the focused warm target-discovery profile, including overlap and ignore-heavy coverage. Treat total wall time and operation counts as advisory, same-machine results.

## Caveats and policy

Timing varies with CPU frequency, background work, Node/V8 version, operating system, and GC history. Compare artifacts from the same platform, architecture, Node major version, and CPU model; CPU-count and memory warnings provide additional runner context. Initial thresholds are advisory until CI variance is characterized. Correctness and instrumentation invariants remain hard failures.

Cross-process caches, stdin spooling, and hard timing gates are not part of the current package.

## Worker parallelism

The production pool uses persistent `node:worker_threads` workers with one file per task. The main thread resolves configuration, per-file overrides, target identity, regression baseline entries, parser requirements, and buffered admission; workers receive file paths and pure data, then read and lint files. Work is parallelized across files, so one huge file does not benefit from extra workers.

Automatic lint scheduling uses at most four workers and requires at least four file targets averaging at least 5 MB each, sufficient available parallelism, no stdin, and only reloadable plugins. Everything else stays on the main thread. Explicit `--workers 1` is strictly sequential; explicit higher counts override the workload threshold but not stdin or plugin capability constraints. Buffered admission and worker refresh remain active with explicit concurrency.

Run `npm run benchmark:workers` or `npm run benchmark:workers:production` to measure the current pool on the current machine. Worker-ready, first-task, execution, total wall time, and process RSS are environment-dependent observations rather than guarantees.
