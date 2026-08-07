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
    'jsonPointer',
    'lintGeoJSON',
    'lintGeoJSONText',
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
