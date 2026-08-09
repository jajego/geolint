# GeoLint

GeoLint checks the GeoJSON your project ships. Run it in CI to catch data-quality problems, control artifact size and complexity, and detect unintended changes before they reach production.

It is built for files generated during builds, exported from data pipelines, committed to repositories, or served directly to browsers. Start with recommended checks; add project-specific budgets and regression baselines when they are useful.

GeoLint is a fast, TypeScript-native, ESLint-style tool that checks structural sanity, quality rules, delivery budgets, and optional regression baselines.

## Try it

```sh
npx geolint map.geojson
```

No config is required. With no discovered config, GeoLint applies `geolint/recommended` immediately.

For a duplicate Feature ID, the pretty reporter looks like this:

```text
map.geojson

  id "same"  error  Feature ID is duplicated.  unique-feature-id

  2 features · 2 vertices · 233 B · 2 ms

✖ 1 error, 0 warnings
```

The duration varies; the diagnostic and summary format are real GeoLint output.

For repeatable local and CI use:

```sh
npm install --save-dev geolint
npx geolint "public/**/*.geojson"
```

## What it checks

| Concern    | Question                                        | GeoLint capability |
| ---------- | ----------------------------------------------- | ------------------ |
| Quality    | Is the artifact internally sane and consistent? | Rules              |
| Budgets    | Is it affordable to ship?                       | Delivery budgets   |
| Regression | Did it materially get worse?                    | Approved baselines |

### Quality

Quality rules catch production problems such as missing or duplicate Feature IDs, property/type drift, unexpected geometry patterns, invalid coordinate ranges, and inconsistent coordinate dimensions. Source-aware rules can also enforce coordinate precision.

Recommended rules cover useful consistency checks out of the box. Add a config when your project needs a more specific policy:

```js
// geolint.config.mjs
import { defineConfig } from 'geolint';

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

A perfectly valid artifact can still become several times larger or more expensive for a browser to parse and render. Budgets make file size, Feature count, total vertices, and per-Feature complexity reviewable policy.

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

Start with ordinary linting. When regression protection is useful, create and review a baseline:

```sh
npx geolint snapshot
git add .geolint-baseline.json
npx geolint "public/**/*.geojson"
```

Quality, budgets, and regression work independently, but together they turn GeoJSON into a testable build artifact: quality catches inconsistency, budgets catch delivery cost, and baselines catch unexpected change over time.

## Make it a CI gate

```json
{
  "scripts": {
    "lint:geojson": "geolint \"public/**/*.geojson\" --format json --max-warnings 0"
  }
}
```

Exit status is `0` when policy passes, `1` for lint, budget, or regression findings (including too many warnings), and `2` for operational failures. JSON output is schema-versioned and suitable for build tooling.

Use GeoLint when your GeoJSON is generated during builds, exported from data pipelines, committed to a repository, served to browsers, or expected to remain structurally stable.

## Use it from Node

GeoLint is ESM-only, requires Node.js 22 or newer, and exposes a typed Node API:

```js
import { lintGeoJSONText } from 'geolint';

const result = await lintGeoJSONText(source, { filename: 'map.geojson' });
for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.code, diagnostic.message);
}
```

Projects with domain-specific policy can add synchronous, typed plugin rules. Plugins are an advanced extension point; see the plugin guide for the worker and trust model.

GeoLint automatically chooses buffered or source-aware analysis according to the policy and selectively parallelizes eligible multi-file workloads. See the performance guide for methodology and tradeoffs rather than universal speed claims.

## Scope

GeoLint catches important structural problems, but it is not a topology engine, geometry repair tool, spatial database, or replacement for a domain-specific GIS validator. It adds production policy around the GeoJSON artifacts you ship.

## Learn more

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
