import assert from 'node:assert/strict';
import test from 'node:test';

import { createLintResult } from '../engine/lint-files.js';
import { lintGeoJSON } from '../engine/lint-input.js';
import { formatJson } from '../reporters/json.js';
import { formatPretty } from '../reporters/pretty.js';

test('JSON reporter preserves Maps and versioned result data', async () => {
  const file = await lintGeoJSON(
    {
      type: 'Feature',
      properties: { name: 'x' },
      geometry: { type: 'Point', coordinates: [0, 0] },
    },
    {
      filename: 'map.geojson',
      config: {
        rules: {
          'consistent-property-types': 'error',
          'consistent-geometry-types': 'error',
        },
      },
    },
  );
  const parsed = JSON.parse(formatJson(createLintResult([file], 0)));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.geolintVersion, '0.0.0');
  assert.equal(parsed.files[0].summary.propertyStats.name.present, 1);
  assert.equal(parsed.files[0].summary.featureGeometryTypes.Point, 1);
  assert.equal(JSON.stringify(parsed).includes('\u001b['), false);
});

test('pretty reporter shows codes, suppression, skips, and summary facts', async () => {
  const file = await lintGeoJSON(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
        {
          type: 'Feature',
          properties: [],
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
        {
          type: 'Feature',
          properties: {},
          geometry: { type: 'Point', coordinates: [0, 0] },
        },
      ],
    },
    {
      filename: 'map.geojson',
      config: {
        rules: {
          'require-feature-id': 'warn',
          'consistent-property-types': 'error',
        },
        diagnostics: { maxPerCodePerFile: 1 },
      },
    },
  );
  const output = formatPretty(createLintResult([file], 0));
  assert.match(output, /require-feature-id/);
  assert.match(output, /additional occurrences suppressed/);
  assert.match(output, /consistent-property-types · incomplete propertyStats/);
  assert.match(output, /3 features/);
  assert.equal(output.includes('\u001b['), false);
});
