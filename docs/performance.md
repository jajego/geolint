# GeoLint performance

GeoLint's benchmark suite measures product linting, parser strategies, source-aware policies, hostile inputs, diagnostic floods, sequential batches, cold CLI startup, and isolated peak process memory. Timing comparisons are advisory; correctness and traversal invariants fail the benchmark command.

## Commands

```sh
npm run benchmark
npm run benchmark:extended
npm run benchmark:json
npm run benchmark:compare -- baseline.json current.json 20
```

The standard suite is the normal development and CI check. The extended suite adds dedicated child-process peak-RSS measurements. Either suite accepts `--output benchmark-results/name.json`; generated JSON artifacts are ignored by Git. CI writes the standard artifact and uploads it from the Ubuntu job.

## Methodology

Fixtures are deterministic and generated before timed regions. Member-order randomization uses a fixed seed. Every warm in-process case, including indexed detail, buffered detail, and multi-rule traversal instrumentation, runs one complete discarded warmup before fresh per-sample instrumentation is collected. Inputs of at least 5 MB use three measured samples and smaller inputs use five; the median is primary. Fixture byte counts are computed before timing.

Cold-start cases launch a fresh built CLI process for each of five samples. They separately measure `--version`, `--help`, and a small clean JSON lint. They are not compared with warm engine throughput.

Peak RSS cases each run in a dedicated child process and report the larger of Node's process RSS and `resourceUsage().maxRSS`. The measurement includes the source text and fixture representation resident in that process. It is not a constant-memory claim and is not directly comparable across operating systems.

Throughput uses actual result Features and vertices. Indexed detail cases retain syntax-validation, initial-index-replay, semantic-replay, object/span, replayed-byte, traversal, Position-visit, and path-materialization instrumentation. Buffered detail separately measures `JSON.parse` and semantic scanning.

## Artifact schema

Benchmark artifacts use schema version 1 independently of package semver:

```json
{
  "schemaVersion": 1,
  "geolintVersion": "0.0.0",
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

The suite covers 10k/100k/1m points, LineString, Polygon, nested mixed GeometryCollections, one huge Feature, many tiny Features, wide/sparse/mixed properties, canonical/fixed-seed random member order, losing/winning huge duplicate coordinates, minified/pretty source, and high-cardinality failures.

Named profiles are `structural`, `recommended`, `source-precision`, `source-feature-bytes`, `source-combined`, `regression`, `snapshot-facts`, and `high-cardinality-failure`. A three-plugin-coordinate-hook case measures dispatch while asserting one coordinate traversal and exactly three callbacks per Position.

## Phase 10 baseline and findings

Measurements below were collected on Node v26.5.1, Windows x64, an Intel i9-9900K. They characterize this machine only.

| Case                                          |     Median |
| --------------------------------------------- | ---------: |
| recommended 100k points                       |    11.7 ms |
| recommended 1m points                         |   187.2 ms |
| source precision 100k                         |   110.7 ms |
| source precision 1m                           | 1,117.3 ms |
| Feature-byte budget, huge 100k-vertex Feature |   103.1 ms |
| combined source policy, 10k Features          |    75.1 ms |
| many tiny Features, 100k                      |   152.7 ms |
| wide properties, 10k keys                     |     8.8 ms |
| sparse properties, 10k Features               |    15.1 ms |
| mixed property types, 10k Features            |    12.6 ms |
| hostile losing duplicate, indexed detail      |    21.2 ms |
| 100k coordinate failures                      |    18.1 ms |
| CLI small lint cold start                     |   141.4 ms |
| regression batch, 10 medium files             |    28.9 ms |
| regression batch, 100 small files             |    68.7 ms |

Buffered versus indexed semantic-only medians were 2.3/9.8 ms at 10k, 11.3/76.7 ms at 100k, and 181.1/754.1 ms at 1m. There is no measured crossover. The automatic strategy remains: buffered `JSON.parse` for semantic-only work and indexed execution only when exact source capabilities require it.

At 100k points, buffered attribution was 6.0 ms in `JSON.parse` and 10.5 ms in semantic scanning. Indexed attribution was 8.8 ms syntax validation, 8.8 ms initial index replay, and 82.0 ms semantic/lazy replay. Source precision performs required numeric-token decoding and decimal analysis, so its 110.7 ms versus recommended's 11.7 ms is not described as parser-only overhead.

The losing duplicate case replayed and syntax-validated 928,971 source bytes but visited exactly one winning Position. The winning duplicate visited 100,000 Positions and took 99.0 ms versus 21.2 ms for the losing case. Both used one coordinate traversal and materialized no coordinate paths.

Fixed-seed randomized member order measured 18.0 ms versus 15.0 ms canonical. Pretty source was 3,328,961 bytes and 148.2 ms versus minified's 928,949 bytes and 121.3 ms; byte throughput was higher for pretty input because whitespace is cheap.

Many tiny Features were roughly 10.6 times slower than one huge Feature at the same 100k coordinate volume, reflecting Feature lifecycle, ID/property, summary, and path work. GeometryCollection-heavy 10k-position input measured 5.7 ms. Wide, sparse, and mixed-property workloads measured 8.8, 15.1, and 12.6 ms respectively.

Diagnostic floods remained bounded: 100k coordinate failures retained 2 diagnostics and suppressed 99,998; 10k missing IDs retained 2 and suppressed 9,998; 9,999 duplicate-ID findings retained 2; and 10k Feature-budget findings retained 2.

Sequential regression throughput was 345.6 files/s for 10 medium files and 1,455.0 files/s for 100 small files. The baseline is single-threaded and exists for Phase 11 comparison.

Peak RSS measured 55.2 MiB at 10k buffered points, 73.9 MiB at 100k, and 257.0 MiB at 1m. Indexed semantic-only 1m peaked at 162.3 MiB and indexed source-precision at 163.5 MiB, but both were much slower. A huge 100k-vertex Feature peaked at 80.6 MiB, 100k tiny Features at 185.0 MiB, and the indexed losing duplicate at 66.3 MiB. These measurements show input- and policy-dependent growth, not an asymptotic guarantee.

## Profiling and optimization

CPU profiles were collected for recommended and source-aware 1m points, many tiny Features, wide/sparse properties, diagnostic floods, and the losing duplicate. Ordinary lint was dominated by native `JSON.parse`, garbage collection, and coordinate scanning. Source-aware lint was dominated by indexed number decoding, coordinate value materialization, and required decimal analysis. Wide/sparse cases concentrated in property scanning/stat completion; bounded diagnostic retention did not dominate flood workloads. The losing duplicate spent time in syntax/index token handling, not semantic traversal.

The many-Feature profile identified repeated JSON Pointer escaping for numeric Feature indices. A single retained production optimization returns numeric segments directly and skips replacements for strings without `~` or `/`. Three focused post-change medians were 147.4, 156.5, and 149.3 ms versus pre-change runs around 173–177 ms, a repeatable 12–16% improvement. The full artifact measured 177.3 to 152.7 ms (-13.9%). Peak RSS was unchanged (184.6 versus 184.5 MiB). A one-artifact LineString warning was investigated with five independent medians of 11.45–11.76 ms, matching the 11.6 ms baseline; it was timing noise, not a repeatable regression.

No indexed-parser, scanner, rule-dispatch, diagnostic, or planner optimization was retained. Profiles showed their costs correspond to required work, and no additional small change met the evidence threshold.

## Caveats and policy

Timing varies with CPU frequency, background work, Node/V8 version, operating system, and GC history. Compare artifacts from the same platform, architecture, Node major version, and CPU model; CPU-count and memory warnings provide additional runner context. Initial thresholds are advisory until CI variance is characterized. Correctness and instrumentation invariants remain hard failures.

Workers, worker-pool heuristics, cross-process caches, stdin spooling, parser rewrites, and hard timing gates are deferred to their designated later phases.
