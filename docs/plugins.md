# Plugin authoring

Plugins add synchronous GeoJSON rules under a user-selected namespace. Everything in this guide is exported from `@jajego/geolint`; plugins do not import GeoLint source files or `dist/*` paths.

## A small complete plugin

```ts
// src/index.ts
import { definePlugin, defineRule, optionSchema } from '@jajego/geolint';

const requireFeatureId = defineRule({
  meta: { name: 'require-feature-id', schema: null },
  create(context) {
    return {
      feature(feature) {
        if (feature.id === undefined) {
          context.report({
            message: 'Feature needs an ID.',
            path: feature.path,
          });
        }
      },
    };
  },
});

const allowedStatus = defineRule({
  meta: {
    name: 'allowed-status',
    schema: optionSchema.object({
      property: optionSchema.string(),
      allowed: optionSchema.array(optionSchema.string()),
    }),
  },
  create(context, options) {
    return {
      propertyValue(property) {
        if (
          property.key === options.property &&
          typeof property.value === 'string' &&
          !options.allowed.includes(property.value)
        ) {
          context.report({
            message: `Property ${property.key} has an unsupported value.`,
            path: property.path,
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { apiVersion: 1, moduleUrl: import.meta.url, exportName: 'default' },
  rules: {
    'require-feature-id': requireFeatureId,
    'allowed-status': allowedStatus,
  },
});
```

`defineRule()` infers the `options` type from `meta.schema`; rules with `schema: null` receive only `context`. `optionSchema` provides `string`, `number`, `enum`, `array`, `object`, `optional`, and `refine`. Options are validated when the configured rule is enabled. Invalid options throw `GeoLintConfigError` with `GEOLINT_INVALID_RULE_OPTIONS`.

Register the plugin in an executable config. JSON config files cannot import executable plugins.

```ts
// geolint.config.mts
import { defineConfig } from '@jajego/geolint';
import quality from '@acme/geolint-plugin-quality';

export default defineConfig({
  plugins: { quality },
  rules: {
    'quality/require-feature-id': 'error',
    'quality/allowed-status': [
      'error',
      { property: 'status', allowed: ['active', 'planned'] },
    ],
  },
});
```

The namespace belongs to the consuming project, so a rule's `meta.name` is its local name and must match its key in `rules`. Rule IDs in config are `namespace/local-name`. GeoLint reports unknown rules as `GEOLINT_UNKNOWN_RULE` and invalid plugin definitions as `GEOLINT_INVALID_PLUGIN`.

## Rule lifecycle and diagnostics

Each enabled rule gets a fresh `create(context, options)` call for each file. Keep per-file state in that closure; do not rely on module-global mutable state. Local hooks run synchronously in deterministic semantic traversal order, not a universal source-member order. In particular, `property` and `propertyValue` use canonical JavaScript code-unit key order: properties written as `{ "z": 1, "a": 2 }` are observed as `a`, then `z`.

`document` is finalization, not another traversal event: GeoLint invokes it once after scanning when its declared facts are complete. If a rule's `meta.requires` fact is incomplete because the input is malformed, GeoLint skips that finalization and records the reason in `skippedPolicies`.

| Hook               | Receives                | Use it for                                       |
| ------------------ | ----------------------- | ------------------------------------------------ |
| `featureStart`     | `FeatureStartEvent`     | Feature path/index before its contents           |
| `property`         | `PropertyEvent`         | Property name and JSON value type                |
| `propertyValue`    | `PropertyValueEvent`    | Property values                                  |
| `coordinate`       | `CoordinateEvent`       | Numeric coordinate values                        |
| `coordinateLexeme` | `CoordinateLexemeEvent` | Original coordinate number spellings and offsets |
| `geometry`         | `GeometrySummary`       | Completed geometry summaries                     |
| `feature`          | `FeatureSummary`        | Completed Feature summaries                      |
| `document`         | `FileSummary`           | File-wide finalization when required facts allow |

Call `context.report({ message, path, featureIndex, featureId, byteOffset, data })` to make a standard rule diagnostic. GeoLint supplies the configured rule ID and severity. `path` is a JSON Pointer; source-aware hooks can also provide `byteOffset`. Diagnostics are subject to the configured diagnostic limits just like built-in rules.

Rule exceptions are operational failures (`GeoLintPluginError` / `GEOLINT_PLUGIN_ERROR`), not lint diagnostics. Hooks and `create` must be synchronous.

## File-wide rules

Use `document` for state collected by earlier hooks, or declare facts in `meta.requires` when a summary fact is enough. Declared facts make the relevant summary fields non-optional in the TypeScript type and require a `document` hook.

```ts
const minimumFeatures = defineRule({
  meta: {
    name: 'minimum-features',
    schema: optionSchema.object({ minimum: optionSchema.number() }),
    requires: ['featureCount'] as const,
  },
  create(context, options) {
    return {
      document(summary) {
        if (summary.featureCount < options.minimum) {
          context.report({ message: 'Too few Features.' });
        }
      },
    };
  },
});
```

Available facts are `featureCount`, `vertexCount`, `propertyStats`, `geometryStats`, `idStats`, `coordinateDimensionStats`, and `derivedExtent`.

## Source-aware rules

Return a `coordinateLexeme` hook when a rule needs the literal spelling of coordinate numbers. GeoLint automatically selects source-aware execution for text/files; plugin authors do not choose a parser strategy.

```ts
coordinateLexeme(event) {
  if (event.rawValues.some((value) => /[eE]/.test(value))) {
    context.report({
      message: 'Exponent notation is not allowed.',
      path: event.path,
      ...(event.byteOffset === undefined ? {} : { byteOffset: event.byteOffset }),
    });
  }
}
```

`lintGeoJSONText()` and file/batch linting preserve this source information. `lintGeoJSON()` receives an already-parsed JavaScript value, so it rejects an enabled `coordinateLexeme` rule with `GeoLintCapabilityError` / `GEOLINT_CAPABILITY_NUMERIC_LEXEMES`. Disable source-aware rules for parsed-object calls when that is appropriate.

## Workers and packaging

Workers reload a plugin module inside each worker. Publish an ESM entry point and include both `moduleUrl: import.meta.url` and the exported plugin's `exportName` (`'default'` above, or a named export). They must be supplied together.

Plugins without that metadata work for ordinary main-thread linting. Automatic worker selection falls back to the main thread; an explicit worker count above one reports `GEOLINT_CAPABILITY_PLUGIN_NOT_RELOADABLE`. Rule options must also be structured-clone-safe for worker execution. `lintFiles({ workers: 1 })` is sequential; pass a higher count or use the CLI's `--workers` to request file-level parallelism.

Use a peer dependency so the host and plugin share one GeoLint API, plus the same package as a development dependency to build and test the plugin:

```json
{
  "type": "module",
  "exports": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "peerDependencies": { "@jajego/geolint": "^0.1.4" },
  "devDependencies": {
    "@jajego/geolint": "^0.1.4",
    "typescript": "^5.8.0"
  }
}
```

Test a plugin with the regular public API; no special harness is required:

```ts
import { lintGeoJSONText } from '@jajego/geolint';
import plugin from './dist/index.js';

const result = await lintGeoJSONText(source, {
  filename: 'map.geojson',
  config: {
    plugins: { quality: plugin },
    rules: { 'quality/require-feature-id': 'error' },
  },
});
```

For publish confidence, build the plugin, `npm pack` it, install both packed tarballs into a blank consumer, and run the consumer with `--workers 1` and a worker count above one. Plugins are trusted executable code; GeoLint does not sandbox them.
