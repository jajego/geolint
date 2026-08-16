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

## Source-aware policies

Ordinary semantic policies use the cheaper buffered strategy. Policies that need exact source facts, such as coordinate numeric lexemes for `coordinate-precision`, use source-aware indexed analysis and can be materially slower on large coordinate-heavy files. GeoLint selects the cheapest correct strategy automatically.

## Methodology

Fixtures are deterministic and generated before timed regions. Member-order randomization uses a fixed seed. Every warm in-process case, including indexed detail, buffered detail, and multi-rule traversal instrumentation, runs one complete discarded warmup before fresh per-sample instrumentation is collected. Inputs of at least 5 MB use three measured samples and smaller inputs use five; the median is primary. Fixture byte counts are computed before timing.

Cold-start cases launch a fresh built CLI process for each of five samples. They separately measure `--version`, `--help`, and a small clean JSON lint. They are not compared with warm engine throughput.

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

The suite covers 10k/100k/1m points, LineString, Polygon, nested mixed GeometryCollections, one huge Feature, many tiny Features, wide/sparse/mixed properties, canonical/fixed-seed random member order, losing/winning huge duplicate coordinates, minified/pretty source, and high-cardinality failures.

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

Buffered versus indexed semantic-only medians were 3.4/16.6 ms at 10k, 23.4/111.8 ms at 100k, and 281.8/1,085.8 ms at 1m. There is no measured crossover. The automatic strategy remains: buffered `JSON.parse` for semantic-only work and indexed execution only when exact source capabilities require it.

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

No indexed-parser, semantic-scanner, rule-dispatch, diagnostic, or planner optimization was retained. Profiles showed their costs correspond to required work, and no additional small change met the evidence threshold.

## Target discovery

Target discovery retains `fast-glob`. The team evaluated Node's `fsPromises.glob()`, a custom `readdir`/Dirent walker, fast-glob post-processing, casing recovery, and physical identity resolution. On large sparse trees, fast-glob materially outperformed the Node-native alternatives.

Profiling then identified GeoLint-owned repeated casing reads and serial `realpath()` calls as the remaining costs. Each `resolveTargets()` call now shares casing-directory reads and exact-input physical-path resolutions, then resolves distinct physical paths with a bounded concurrency of eight before reducing aliases deterministically. This preserves canonical casing and physical-identity semantics without any configuration change.

On the reference Windows machine, the bounded physical-identity work reduced end-to-end target resolution by approximately 42% for a small set, 63% for medium, 54% for a 50k sparse tree, 60% for 10k matches, 52% for deep paths, 56% for a wide directory, and 54% for overlapping patterns. Casing-read memoization reduced 10k-match reads from 30,000 to about 52, deep-path reads from 7,500 to about 34, and wide-directory reads from 2,000 to 2. The performance curve generally plateaued around four to eight workers; 16 and 32 had inconsistent marginal gains with more filesystem pressure.

Run `npm run benchmark:targets` for the focused warm target-discovery profile. Its per-pattern phase timings can overlap because configured patterns expand concurrently; treat the total wall time and operation counts as the comparable results.

## Caveats and policy

Timing varies with CPU frequency, background work, Node/V8 version, operating system, and GC history. Compare artifacts from the same platform, architecture, Node major version, and CPU model; CPU-count and memory warnings provide additional runner context. Initial thresholds are advisory until CI variance is characterized. Correctness and instrumentation invariants remain hard failures.

Cross-process caches, stdin spooling, parser rewrites, and hard timing gates are not part of the current package.

## Worker parallelism

Worker measurements use a persistent `node:worker_threads` pool with one file per task. The main thread resolves configuration, per-file overrides, target identity, and regression baseline entries; workers receive file paths and pure data, read files themselves, and execute built-in rules. Each isolated result uses one untimed warmup followed by three or five measured invocations including pool startup and termination. Worker-ready, first-task, steady execution, total wall time, and process RSS are recorded separately.

On Node v26.5.1, Windows x64, an Intel i9-9900K with 16 available logical CPUs, median results were:

| Workload                   | Main thread |   1 worker |  2 workers |  4 workers |  8 workers | Main RSS | 4-worker RSS |
| -------------------------- | ----------: | ---------: | ---------: | ---------: | ---------: | -------: | -----------: |
| 100 small files            |     27.6 ms |   112.2 ms |    91.9 ms |    92.0 ms |   114.5 ms | 56.5 MiB |    134.7 MiB |
| 10 medium files            |    111.8 ms |   247.3 ms |   177.7 ms |   171.8 ms |   257.2 ms | 98.0 MiB |    314.8 MiB |
| 4 large buffered files     |    891.2 ms |   853.7 ms |   568.4 ms |   441.4 ms |   430.0 ms |  473 MiB |      917 MiB |
| 8 large buffered files     |  1,549.5 ms | 1,597.3 ms |   966.9 ms |   801.5 ms |   723.0 ms |  399 MiB |    1,247 MiB |
| 4 large source-aware files |  3,892.2 ms | 4,138.2 ms | 2,205.8 ms | 1,301.4 ms | 1,337.1 ms |  207 MiB |      341 MiB |
| 8 large source-aware files |  7,870.7 ms | 8,139.4 ms | 4,487.1 ms | 2,509.5 ms | 2,204.1 ms |  144 MiB |      379 MiB |
| 4 Feature-heavy files      |    684.1 ms |   788.7 ms |   462.4 ms |   430.1 ms |   485.7 ms |  293 MiB |      520 MiB |
| 10-file regression batch   |    113.4 ms |   226.5 ms |   161.3 ms |   183.9 ms |   237.5 ms |  104 MiB |      327 MiB |

Pool readiness was roughly 62–78 ms at one to four workers and 92–114 ms at eight. A repeat run reproduced eight source-aware files at 7,901 ms sequential versus 2,612 ms with four workers (3.02×), and eight buffered files at 1,828 ms versus 818 ms (2.24×). The 100-small-file regression also reproduced.

These measurements show repeatable wall-clock improvements for sufficiently large multi-file workloads at four workers. Source-aware work gains the most in the measured cases. Cheap and medium batches become slower, and buffered memory can exceed 1 GiB, so GeoLint keeps `workers=1` strictly single-threaded and uses a conservative automatic threshold. One huge GeoJSON file cannot benefit because work is parallelized only across files.

### Production measurements

The production pool uses versioned task messages, explicit error envelopes, plugin reload/identity validation and caching, crash replacement, ordered settlement, and snapshot tasks. Its one-to-four-worker readiness cost was about 101–145 ms. The measured results retain the large-workload benefit:

| Workload                   | Main thread |  2 workers |  4 workers |  8 workers | 4-worker speedup | 4-worker RSS |
| -------------------------- | ----------: | ---------: | ---------: | ---------: | ---------------: | -----------: |
| 100 small files            |     25.1 ms |   135.0 ms |   133.8 ms |   163.6 ms |            0.19× |      146 MiB |
| 10 medium files            |    108.7 ms |   212.5 ms |   214.8 ms |   286.3 ms |            0.51× |      324 MiB |
| 4 large buffered files     |    756.2 ms |   590.6 ms |   443.4 ms |   527.5 ms |            1.71× |      918 MiB |
| 8 large buffered files     |  1,483.7 ms | 1,016.8 ms |   789.5 ms |   813.0 ms |            1.88× |    1,164 MiB |
| 4 large source-aware files |  3,866.6 ms | 2,254.2 ms | 1,475.2 ms | 1,560.5 ms |            2.62× |      349 MiB |
| 8 large source-aware files |  8,032.6 ms | 4,205.4 ms | 2,555.5 ms | 2,097.9 ms |            3.14× |      388 MiB |
| 4 Feature-heavy files      |    667.0 ms |   520.7 ms |   372.8 ms |   411.2 ms |            1.79× |      494 MiB |
| 10-file regression batch   |    113.6 ms |   204.0 ms |   205.5 ms |   264.5 ms |            0.55× |      333 MiB |

Eight large snapshot inputs measured 1,460.9 ms sequentially, 919.2 ms with two workers, 720.4 ms with four, and 683.7 ms with eight. Four workers used 1,336 MiB versus 479 MiB sequentially, so snapshot parallelism is available when explicitly requested but is not selected automatically.

Automatic lint scheduling uses at most four workers and requires at least four file targets averaging at least 5 MB each, sufficient available parallelism, no stdin, and only reloadable plugins. Everything else stays on the main thread. Explicit `--workers 1` is always strictly sequential; explicit higher counts override the workload threshold but not stdin or plugin capability constraints. Worker benchmark artifacts record architecture, execution mode, and worker count as workload identity.
