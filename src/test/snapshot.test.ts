import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GeoLintInputError, GeoLintTargetError } from '../engine/errors.js';
import {
  parseBaseline,
  serializeBaseline,
  createBaseline,
  type BaselineFileEntry,
} from '../regression/schema.js';
import { snapshotBaseline } from '../regression/snapshot.js';
import type { GeoLintConfig } from '../types/config.js';

function point(id: string | number | undefined, value: unknown = 1) {
  return {
    type: 'Feature',
    ...(id === undefined ? {} : { id }),
    properties: { value },
    geometry: { type: 'Point', coordinates: [0, 0] },
  };
}

function oldEntry(): BaselineFileEntry {
  return {
    bytes: 1,
    featureCount: 0,
    totalVertices: 0,
    largestFeatureVertices: 0,
    featureGeometryTypes: {},
    properties: {},
    ids: { missing: 0, duplicates: 0, string: 0, number: 0 },
    nullGeometries: 0,
  };
}

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'geolint-snapshot-'));
}

async function writeGeoJSON(directory: string, name: string, value: unknown) {
  await writeFile(join(directory, name), JSON.stringify(value));
}

test('snapshot requires an explicit non-empty target set or config.files', async () => {
  const directory = await project();
  try {
    await assert.rejects(
      snapshotBaseline({ cwd: directory, config: {} }),
      GeoLintTargetError,
    );
    await assert.rejects(
      snapshotBaseline({ cwd: directory, targets: [], config: {} }),
      GeoLintTargetError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('full snapshot adds, updates, removes, and creates baseline directories', async () => {
  const directory = await project();
  try {
    await writeGeoJSON(directory, 'a.geojson', point('a'));
    await writeGeoJSON(directory, 'c.geojson', point('c'));
    const baselinePath = join(directory, 'state', 'baseline.json');
    const initial = createBaseline({
      'a.geojson': oldEntry(),
      'b.geojson': oldEntry(),
    });
    await mkdir(join(directory, 'state'));
    await writeFile(baselinePath, serializeBaseline(initial));

    const result = await snapshotBaseline({
      cwd: directory,
      config: {
        files: ['{a,c}.geojson'],
        regression: { baseline: 'state/baseline.json' },
      },
    });
    assert.deepEqual(
      result.proposal.added.map(({ filePath }) => filePath),
      ['c.geojson'],
    );
    assert.deepEqual(
      result.proposal.updated.map(({ filePath }) => filePath),
      ['a.geojson'],
    );
    assert.deepEqual(
      result.proposal.removed.map(({ filePath }) => filePath),
      ['b.geojson'],
    );
    const persisted = parseBaseline(await readFile(baselinePath, 'utf8'));
    assert.deepEqual(Object.keys(persisted.files), ['a.geojson', 'c.geojson']);
    assert.equal(persisted.files['a.geojson']?.totalVertices, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('partial snapshot updates only explicit targets', async () => {
  const directory = await project();
  try {
    await writeGeoJSON(directory, 'a.geojson', point('a'));
    const baselinePath = join(directory, 'baseline.json');
    await writeFile(
      baselinePath,
      serializeBaseline(
        createBaseline({ 'a.geojson': oldEntry(), 'b.geojson': oldEntry() }),
      ),
    );
    const result = await snapshotBaseline({
      cwd: directory,
      targets: ['a.geojson'],
      config: { regression: { baseline: 'baseline.json' } },
    });
    assert.equal(result.proposal.mode, 'partial');
    assert.deepEqual(Object.keys(result.baseline.files), [
      'a.geojson',
      'b.geojson',
    ]);
    assert.equal(result.baseline.files['b.geojson']?.bytes, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot failure leaves the original baseline byte-identical', async () => {
  const directory = await project();
  try {
    await writeGeoJSON(directory, 'a.geojson', point('a'));
    await writeFile(join(directory, 'b.geojson'), '{');
    await writeGeoJSON(directory, 'c.geojson', point('c'));
    const baselinePath = join(directory, 'baseline.json');
    const original = serializeBaseline(createBaseline({ old: oldEntry() }));
    await writeFile(baselinePath, original);
    await assert.rejects(
      snapshotBaseline({
        cwd: directory,
        config: {
          files: ['{a,b,c}.geojson'],
          regression: { baseline: 'baseline.json' },
        },
      }),
      GeoLintInputError,
    );
    assert.equal(await readFile(baselinePath, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot rejects invalid UTF-8 source bytes', async () => {
  const directory = await project();
  try {
    await writeFile(join(directory, 'bad.geojson'), Uint8Array.of(0xff));
    await assert.rejects(
      snapshotBaseline({
        cwd: directory,
        targets: ['bad.geojson'],
        config: {},
      }),
      (error) =>
        error instanceof GeoLintInputError &&
        error.code === 'GEOLINT_SNAPSHOT_INVALID_ENCODING',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot ignores ordinary policies and captures objective complete facts', async () => {
  const directory = await project();
  try {
    await writeGeoJSON(directory, 'map.geojson', {
      type: 'FeatureCollection',
      features: [point('same', 1), point('same', null)],
    });
    const config: GeoLintConfig = {
      extends: ['geolint/web'],
      files: ['map.geojson'],
      plugins: { unavailable: {} },
      budgets: { featureCount: 0 },
      regression: {
        baseline: 'nested/baseline.json',
        checks: { propertyTypes: { widened: 'error' } },
      },
    };
    const result = await snapshotBaseline({ cwd: directory, config });
    const entry = result.baseline.files['map.geojson']!;
    assert.equal(entry.ids.duplicates, 1);
    assert.deepEqual(entry.properties.value!.types, { number: 1, null: 1 });
    assert.equal(entry.featureCount, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot accepts harmless document damage but blocks incomplete required facts', async () => {
  const directory = await project();
  try {
    await writeGeoJSON(directory, 'safe.geojson', {
      ...point('safe'),
      bbox: ['bad'],
    });
    await snapshotBaseline({
      cwd: directory,
      targets: ['safe.geojson'],
      config: { regression: { baseline: 'baseline.json' } },
    });
    const original = await readFile(join(directory, 'baseline.json'), 'utf8');

    await writeGeoJSON(directory, 'bad.geojson', {
      ...point('bad'),
      properties: 42,
    });
    await assert.rejects(
      snapshotBaseline({
        cwd: directory,
        targets: ['bad.geojson'],
        config: { regression: { baseline: 'baseline.json' } },
      }),
      (error) =>
        error instanceof GeoLintInputError &&
        error.code === 'GEOLINT_SNAPSHOT_INCOMPLETE',
    );
    assert.equal(
      await readFile(join(directory, 'baseline.json'), 'utf8'),
      original,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot schema is independent of ordinary and regression policy', async () => {
  const directory = await project();
  try {
    await writeGeoJSON(directory, 'map.geojson', point(1));
    const first = await snapshotBaseline({
      cwd: directory,
      targets: ['map.geojson'],
      config: { regression: { baseline: 'one.json' } },
    });
    const second = await snapshotBaseline({
      cwd: directory,
      targets: ['map.geojson'],
      config: {
        extends: ['geolint/web'],
        budgets: { totalVertices: 0 },
        regression: {
          baseline: 'two.json',
          checks: {
            properties: { added: 'error', removed: 'warn' },
            duplicateIds: { increased: 'error' },
          },
          thresholds: { totalVerticesIncrease: { percentage: 1 } },
        },
      },
    });
    assert.deepEqual(
      first.baseline.files['map.geojson'],
      second.baseline.files['map.geojson'],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
