# GeoLint

Fast quality gates for production GeoJSON.

GeoLint is in active development. Configuration and target resolution are in
place, along with structural recovery, buffered and indexed-source execution,
V1 quality rules, and semantic/source budgets through the `lintGeoJSON()`,
`lintGeoJSONText()`, and `lintFile()` Node APIs. Schema-v1 regression baselines
and full/partial snapshot approval are also available; snapshot execution is
independent of ordinary lint policy.

```sh
npm install --save-dev geolint
npx geolint --help
npx geolint --print-config public/map.geojson
npx geolint snapshot
```

## Plugins

External rules use the same synchronous semantic hooks and option schemas as
built-in rules. Register a plugin under a local namespace, then configure its
rules as `namespace/rule`:

```ts
import { defineConfig, definePlugin, defineRule } from 'geolint';

const requireName = defineRule({
  meta: { name: 'require-name', schema: null },
  create(context) {
    return {
      feature(feature) {
        if (feature.properties.count === 0) {
          context.report({ message: 'Feature needs properties.' });
        }
      },
    };
  },
});

const plugin = definePlugin({
  meta: {
    apiVersion: 1,
    moduleUrl: import.meta.url,
    exportName: 'default',
  },
  rules: { 'require-name': requireName },
});

export default defineConfig({
  plugins: { acme: plugin },
  rules: { 'acme/require-name': 'error' },
});
```

Plugins are trusted application code executed in-process; GeoLint does not
sandbox them. Hooks must be synchronous. A `coordinateLexeme` hook
automatically selects source-aware indexed execution and therefore cannot run
against already-parsed object input. Optional `plugin.configs` policy fragments
are typed and preserved, but Phase 8 does not give them magic `extends` names.
