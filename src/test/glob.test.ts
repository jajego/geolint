import assert from 'node:assert/strict';
import test from 'node:test';

import { assertGlob, matchesGlob } from '../config/glob.js';
import { GeoLintConfigError } from '../engine/errors.js';

const validPatterns: readonly [string, string][] = [
  ['map.geojson', '*.geojson'],
  ['map1.geojson', 'map?.geojson'],
  ['a/b/map.geojson', 'a/**/map.geojson'],
  ['a/map.geojson', 'a/**/map.geojson'],
  ['a.geojson', '[abc].geojson'],
  ['m.geojson', '[a-z].geojson'],
  ['a/map.geojson', '{a,b}/map.geojson'],
  ['foo/one.geojson', 'foo/{one,two}.geojson'],
];

const invalidPatterns = [
  '',
  '!foo.geojson',
  '@(foo|bar).geojson',
  '+(foo|bar).geojson',
  '?(foo|bar).geojson',
  '*(foo|bar).geojson',
  '!(foo|bar).geojson',
  'foo/**bar.geojson',
  'foo/ab**cd.geojson',
  'foo/***/bar.geojson',
  'foo/{1..3}.geojson',
  'foo/{a,{b,c}}.geojson',
  'foo/{a,b.geojson',
  'foo/a}.geojson',
  'foo/{a,}.geojson',
  'foo/[abc.geojson',
  'foo/[]/map.geojson',
  'foo/[!ab]/map.geojson',
] as const;

test('V1 glob validator accepts only the documented subset', () => {
  for (const [, pattern] of validPatterns)
    assert.doesNotThrow(() => assertGlob(pattern));
  for (const pattern of invalidPatterns) {
    assert.throws(
      () => assertGlob(pattern),
      (error) =>
        error instanceof GeoLintConfigError &&
        error.code === 'GEOLINT_INVALID_GLOB',
      pattern,
    );
  }
});

test('the supported V1 glob constructs match as documented', () => {
  for (const [path, pattern] of validPatterns) {
    assert.equal(
      matchesGlob(path, [pattern]),
      true,
      `${pattern} should match ${path}`,
    );
  }
});

test('glob matching normalizes separators without matching dot segments', () => {
  assert.equal(matchesGlob('public\\maps\\a.geojson', ['public/**']), true);
  assert.equal(matchesGlob('.fixtures/a.geojson', ['**/*.geojson']), false);
  assert.equal(
    matchesGlob('.fixtures/a.geojson', ['.fixtures/**/*.geojson']),
    true,
  );
});
