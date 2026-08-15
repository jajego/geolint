# Node API

GeoLint is ESM-only. All public imports come from `@jajego/geolint`.

```js
import {
  lintFile,
  lintFiles,
  lintGeoJSON,
  lintGeoJSONText,
} from '@jajego/geolint';

const valueResult = await lintGeoJSON({ type: 'Point', coordinates: [0, 0] });
const textResult = await lintGeoJSONText(source, { filename: 'map.geojson' });
const fileResult = await lintFile('public/map.geojson');
const batchResult = await lintFiles({ targets: ['public/**/*.geojson'] });
```

- `lintGeoJSON(value)` validates an already-parsed JSON value. Exact source bytes, numeric lexemes, and Feature spans are unavailable.
- `lintGeoJSONText(text)` retains source capabilities, including duplicate JSON object-key diagnostics, and accepts a logical `filename` for overrides/regression identity.
- `lintFile(path)` reads one file.
- `lintFiles(options)` resolves config, targets, baselines, and eligible file-level workers and returns schema-v1 aggregate results.

Configuration can be provided as an object or path through API options. Results and their nested public collections are readonly.

## Strict JSON values

`lintGeoJSON` accepts ordinary JSON data only. It rejects cycles, sparse arrays, symbols, non-finite numbers, accessors, Proxies, and class instances with `GeoLintInputError` / `GEOLINT_INVALID_JSON_VALUE`.

Parsed values cannot retain duplicate object members, so duplicate-key diagnostics are available only through text and file input.

Operational failures throw documented `GeoLintError` subclasses. Batch operations may throw `GeoLintBatchError`; inspect `errors` and `partialResult`. Branch on classes/codes, never message text. See [errors.md](errors.md).
