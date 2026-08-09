# Plugin authoring

Plugins add synchronous semantic rules under a user-selected namespace.

```js
// geolint-plugin.mjs
import { definePlugin, defineRule } from 'geolint';

const requireId = defineRule({
  meta: { name: 'require-id', schema: null },
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

export default definePlugin({
  meta: {
    apiVersion: 1,
    moduleUrl: import.meta.url,
    exportName: 'default',
  },
  rules: { 'require-id': requireId },
});
```

```js
// geolint.config.mjs
import { defineConfig } from 'geolint';
import projectPlugin from './geolint-plugin.mjs';

export default defineConfig({
  plugins: { project: projectPlugin },
  rules: { 'project/require-id': 'error' },
});
```

`apiVersion: 1` identifies the V1 plugin contract. Use `optionSchema` in `meta.schema` for typed rule options and `meta.requires` plus a `document` hook for aggregate facts.

`moduleUrl` and `exportName` make a plugin reloadable in workers. Inline/nonreloadable plugins are valid on the main thread; automatic workers fall back, while an explicit incompatible worker count reports a capability error. Hooks are synchronous. Plugin exceptions become `GeoLintPluginError` / `GEOLINT_PLUGIN_ERROR`, not lint diagnostics.

Plugins and executable configs are trusted code executing with the Node process's privileges; GeoLint does not sandbox them.
