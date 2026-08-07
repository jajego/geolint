import assert from 'node:assert/strict';
import test from 'node:test';

import { defineConfig } from '../index.js';

test('defineConfig preserves configuration values', () => {
  const config = defineConfig({ files: ['public/**/*.geojson'] });

  assert.deepEqual(config, { files: ['public/**/*.geojson'] });
});
