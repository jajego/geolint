import assert from 'node:assert/strict';
import test from 'node:test';

import * as geolint from '../index.js';

test('defineConfig preserves configuration values', () => {
  const config = geolint.defineConfig({ files: ['public/**/*.geojson'] });

  assert.deepEqual(config, { files: ['public/**/*.geojson'] });
});

test('root module exports only implemented consumer APIs', () => {
  assert.deepEqual(Object.keys(geolint), ['defineConfig']);
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
