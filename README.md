# GeoLint

[![CI](https://github.com/jajego/geolint/actions/workflows/ci.yml/badge.svg)](https://github.com/jajego/geolint/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@jajego/geolint?label=npm)](https://www.npmjs.com/package/@jajego/geolint)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Quality gates for production GeoJSON.**

GeoLint catches data-quality issues, enforces size and complexity budgets, and detects unintended changes in the GeoJSON your project ships.

## Getting started

Run GeoLint without installing it:

```sh
npx @jajego/geolint map.geojson
```

No config is required. With no discovered config, GeoLint applies `geolint/recommended` immediately.

Example output:

```text
map.geojson

  id "same"  error  Feature ID is duplicated.  unique-feature-id

  2 features · 2 vertices · 233 B · 2 ms

✖ 1 error, 0 warnings
```

Install GeoLint in your project:

```sh
npm install --save-dev @jajego/geolint
npx geolint "public/**/*.geojson"
```

## Why GeoLint instead of a GeoJSON validator?

There are tools such as [`@placemarkio/check-geojson`](https://github.com/placemark/check-geojson), which
are useful when the main question is **“Is this valid GeoJSON?”**

GeoLint is aimed at a different question: **“Is this GeoJSON artifact healthy enough to ship?”**

In addition to structural and semantic checks, GeoLint can enforce project-specific quality rules, delivery budgets, and regression policies. That means it can catch problems such as rising vertex counts, property/type drift, missing IDs, or growth beyond an approved baseline even when the GeoJSON remains perfectly valid.

Use a validator when you primarily need to accept or reject incoming GeoJSON. Use GeoLint when GeoJSON is a maintained or generated build artifact that you want to quality-gate in development and CI.

## Core concepts

| Concern    | Question                                        | GeoLint capability |
| ---------- | ----------------------------------------------- | ------------------ |
| Quality    | Is the artifact internally sane and consistent? | Rules              |
| Budgets    | Is it affordable to ship?                       | Delivery budgets   |
| Regression | Did it materially get worse?                    | Approved baselines |

### Quality

Quality rules catch production problems such as missing or duplicate Feature IDs, property/type drift, unexpected geometry patterns, invalid coordinate ranges, and inconsistent coordinate dimensions. Source input also reports duplicate JSON object keys before their overwritten values disappear. Source-aware rules can enforce coordinate precision.

The recommended preset provides useful consistency checks out of the box. Add a config when your project needs a more specific policy:

```js
// geolint.config.mjs
import { defineConfig } from '@jajego/geolint';

export default defineConfig({
  extends: ['geolint/recommended'],
  files: ['public/**/*.geojson'],
  rules: {
    'require-feature-id': 'error',
    'consistent-property-types': 'error',
    'allowed-geometry-types': ['error', { allow: ['Point', 'Polygon'] }],
  },
});
```

### Budgets

A perfectly valid artifact can still become several times larger or more expensive for a browser to parse and render. Budgets turn file size, Feature count, total vertices, and per-Feature complexity into explicit policy.

These are example project-specific limits, not universal recommendations:

```js
export default {
  budgets: {
    fileSize: { limit: '2MB', severity: 'error' },
    featureCount: 50_000,
    totalVertices: 250_000,
    feature: { vertices: 25_000, bytes: '300KB' },
  },
};
```

### Regression

Generated geospatial artifacts can change materially without a source-code diff making the impact obvious. A committed baseline lets CI compare the artifact itself: file and vertex growth, geometry distribution, property shape, ID quality, and other tracked facts.

Baselines are semantic, not textual. A snapshot stores GeoLint's derived aggregate facts - not a copy, hash, or canonicalized form of the GeoJSON. Whitespace, object-key/property order, Feature order, and equivalent numeric spellings do not change those aggregate facts. The baseline also records byte length for the optional `fileSizeIncrease` threshold, so a reserialization that increases file size can intentionally be reported when that threshold is enabled. Source-sensitive rules remain separate; for example, coordinate precision can inspect the original numeric spelling.

Regression baselines are artifact references, not suppression lists: they do **not** accept or hide rule, budget, or plugin diagnostics. Choose at least one regression threshold or check in configuration, then create and review a baseline:

```js
// geolint.config.mjs
export default {
  regression: {
    baseline: '.geolint-baseline.json',
    thresholds: {
      totalVerticesIncrease: { percentage: 10, minimumIncrease: 1_000 },
    },
  },
};
```

```sh
npx geolint snapshot
git add .geolint-baseline.json
npx geolint "public/**/*.geojson"
```

`snapshot` writes derived facts rather than a copy or hash of the GeoJSON source; it also retains byte length for optional file-size regression.

Quality, budgets, and regression work independently, but together they turn GeoJSON into a testable build artifact: quality catches inconsistency, budgets catch delivery cost, and baselines catch unexpected change over time.

## CI integration

```json
{
  "scripts": {
    "lint:geojson": "geolint \"public/**/*.geojson\" --format json --max-warnings 0"
  }
}
```

Exit status is `0` when policy passes, `1` for lint, budget, or regression findings (including too many warnings), and `2` for operational failures. JSON output is schema-versioned and suitable for build tooling.

## Node API

GeoLint is ESM-only, requires Node.js 22 or newer, and exposes a typed Node API:

```js
import { lintGeoJSONText } from '@jajego/geolint';

const result = await lintGeoJSONText(source, { filename: 'map.geojson' });

for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.code, diagnostic.message);
}
```

Projects with domain-specific policy can add synchronous, typed plugin rules. Plugins are an advanced extension point; see the plugin guide for the worker and trust model.

GeoLint automatically chooses buffered or source-aware analysis according to the policy and selectively parallelizes eligible multi-file workloads. See the performance guide for methodology and tradeoffs rather than universal speed claims.

## Scope

GeoLint catches important structural problems, but it is not a topology engine, geometry repair tool, spatial database, or replacement for a domain-specific GIS validator. It adds production policy around the GeoJSON artifacts you ship.

## Documentation

- [Configuration and CLI](docs/configuration.md) — config discovery, presets, targets, and output
- [Rules](docs/rules.md) — built-in quality checks and options
- [Budgets](docs/budgets.md) — delivery-size and complexity limits
- [Regression](docs/regression.md) — baseline and snapshot workflow
- [Node API](docs/node-api.md) — programmatic linting
- [Plugins](docs/plugins.md) — custom rule authoring and worker compatibility
- [Performance](docs/performance.md) — methodology and execution strategy
- [Errors and exit codes](docs/errors.md) — stable operational behavior
- [Contributing](CONTRIBUTING.md), [security](SECURITY.md), and [releases](docs/releasing.md)

Use `npx geolint --help` for the full CLI option summary and `npx geolint --print-config map.geojson` to inspect the effective per-file policy.

## License

MIT
