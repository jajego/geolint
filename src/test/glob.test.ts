import assert from 'node:assert/strict';
import test from 'node:test';

import { matchesGlob } from '../config/glob.js';

test('the supported V1 glob constructs match as documented', () => {
  const cases: readonly [string, string][] = [
    ['map.geojson', '*.geojson'],
    ['map1.geojson', 'map?.geojson'],
    ['a/b/map.geojson', '**/*.geojson'],
    ['a.geojson', '[abc].geojson'],
    ['m.geojson', '[a-z].geojson'],
    ['a/map.geojson', '{a,b}/map.geojson'],
  ];

  for (const [path, pattern] of cases) {
    assert.equal(
      matchesGlob(path, [pattern]),
      true,
      `${pattern} should match ${path}`,
    );
  }
});

test('glob matching normalizes separators', () => {
  assert.equal(matchesGlob('public\\maps\\a.geojson', ['public/**']), true);
});
