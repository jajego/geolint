import assert from 'node:assert/strict';
import test from 'node:test';

import * as geolint from '../index.js';

test('defineConfig preserves configuration values', () => {
  const config = geolint.defineConfig({ files: ['public/**/*.geojson'] });

  assert.deepEqual(config, { files: ['public/**/*.geojson'] });
});

test('root module exports only implemented consumer APIs', () => {
  assert.deepEqual(Object.keys(geolint), [
    'GeoLintBatchError',
    'GeoLintCapabilityError',
    'GeoLintConfigError',
    'GeoLintError',
    'GeoLintIOError',
    'GeoLintInputError',
    'GeoLintInternalError',
    'GeoLintPluginError',
    'GeoLintTargetError',
    'defineConfig',
    'defineRule',
    'jsonPointer',
    'lintGeoJSON',
    'lintGeoJSONText',
    'optionSchema',
  ]);
});

test('public config types reject override baseline changes', () => {
  geolint.defineConfig({
    overrides: [
      {
        files: ['**/*.geojson'],
        // @ts-expect-error regression.baseline is base-config-only
        regression: { baseline: 'other.json' },
      },
    ],
  });
});

test('semantic event types expose only their promised capability', () => {
  const property = (event: geolint.PropertyEvent) => {
    // @ts-expect-error property() does not provide the value
    void event.value;
  };
  const coordinate = (event: geolint.CoordinateEvent) => {
    // @ts-expect-error coordinate() does not provide numeric lexemes
    void event.rawValues;
  };
  void property;
  void coordinate;
});

test('rule authoring infers options, hooks, aggregate facts, and context shape', () => {
  const schema = geolint.optionSchema.object({
    allow: geolint.optionSchema.array(geolint.optionSchema.string()),
  });
  const rule = geolint.defineRule({
    meta: {
      name: 'type-contract',
      schema,
      requires: ['propertyStats'] as const,
    },
    create(context, options) {
      const allowed: string[] = options.allow;
      context.report({ message: allowed.join(',') });
      context.report({
        message: 'invalid context shape',
        // @ts-expect-error severity belongs to resolved configuration
        severity: 'error',
      });
      return {
        property(event) {
          // @ts-expect-error property() does not expose values
          void event.value;
        },
        propertyValue(event) {
          void event.value;
        },
        coordinate(event) {
          // @ts-expect-error coordinate() does not expose raw lexemes
          void event.rawValues;
        },
        document(summary) {
          void summary.propertyStats.size;
        },
      };
    },
  });
  const noOptions = geolint.defineRule({
    meta: { name: 'no-options', schema: null },
    create(context) {
      return { document: () => void context.ruleId };
    },
  });
  assert.equal(rule.meta.name, 'type-contract');
  assert.equal(noOptions.meta.schema, null);

  geolint.defineRule({
    meta: { name: 'async-hooks-rejected', schema: null },
    // @ts-expect-error V1 rule hooks are synchronous
    create() {
      return {
        async coordinate() {},
      };
    },
  });
});
