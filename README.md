# GeoLint

GeoLint is a fast, TypeScript-native, ESLint-style quality and regression linter for GeoJSON artifacts used in web applications and CI. It checks structural sanity first, then quality rules, artifact facts, opt-in delivery budgets, and optional regression baselines.

GeoLint is not a topology engine, geometry repair tool, spatial database, or replacement for a domain-specific GIS validator.

## Quick start

```sh
npx geolint map.geojson
```

For a duplicate Feature ID, the default reporter looks like this:

```text
map.geojson

  id "same"  error  Feature ID is duplicated.  unique-feature-id

  2 features · 2 vertexs · 233 B · 2 ms

✖ 1 error, 0 warnings
```

For repeatable local and CI use:

```sh
npm install --save-dev geolint
npx geolint "public/**/*.geojson"
```

No config file is required. When no config is discovered, GeoLint applies `geolint/recommended`: duplicate and mixed-type Feature IDs, inconsistent property types, invalid longitude/latitude ranges, and inconsistent coordinate dimensions are errors. Numeric delivery budgets and regression checks remain opt-in.

An explicit or discovered config is authoritative; recommended rules are not silently merged. Extend the preset when you want it:

```js
// geolint.config.mjs
import { defineConfig } from 'geolint';

export default defineConfig({
  extends: ['geolint/recommended'],
  files: ['public/**/*.geojson'],
  rules: { 'require-feature-id': 'warn' },
});
```

## What it catches

- malformed JSON and invalid GeoJSON structure, with bounded diagnostics;
- inconsistent IDs, properties, geometry types, and coordinate dimensions;
- invalid coordinate ranges and source-level coordinate precision;
- opt-in file, Feature, and vertex delivery budgets;
- optional changes against a committed baseline;
- custom project rules through a typed plugin API.

## CI

```sh
npx geolint "public/**/*.geojson" --format json --max-warnings 0
```

Exit status is `0` when policy passes, `1` for lint/quality/budget/regression failures (or too many warnings), and `2` for operational failures.

## Node API

```js
import { lintGeoJSONText } from 'geolint';

const result = await lintGeoJSONText(source, { filename: 'map.geojson' });
for (const diagnostic of result.diagnostics) {
  console.log(diagnostic.code, diagnostic.message);
}
```

GeoLint is ESM-only and requires Node.js 22 or newer.

## Documentation

- [Configuration and CLI](docs/configuration.md)
- [Built-in rules](docs/rules.md)
- [Delivery budgets](docs/budgets.md)
- [Node API](docs/node-api.md)
- [Plugin authoring](docs/plugins.md)
- [Regression baselines](docs/regression.md)
- [Errors and exit codes](docs/errors.md)
- [Performance methodology](docs/performance.md)
- [Contributing](CONTRIBUTING.md), [security](SECURITY.md), and [releases](docs/releasing.md)

Use `npx geolint --help` for the complete CLI option summary and `npx geolint --print-config map.geojson` to inspect the effective per-file policy.

## License

MIT
