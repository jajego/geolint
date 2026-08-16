import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  resolveTargets,
  type TargetResolutionProfile,
} from '../engine/targets.js';
import { matchesGlob } from '../config/glob.js';
import { resolveConfig } from '../config/resolve.js';
import { GeoLintTargetError } from '../engine/errors.js';

async function project(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'geolint-targets-'));
}

test('configured files resolve from project root, not invocation cwd', async () => {
  const root = await project();
  try {
    const cwd = join(root, 'packages', 'app');
    await mkdir(cwd, { recursive: true });
    await mkdir(join(root, 'public'));
    await writeFile(join(root, 'public', 'map.geojson'), '{}');
    const config = resolveConfig({ files: ['public/**/*.geojson'] }, root);

    const targets = await resolveTargets(config, undefined, cwd);

    assert.deepEqual(
      targets.map(({ filePath }) => filePath),
      ['public/map.geojson'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit targets resolve from invocation cwd', async () => {
  const root = await project();
  try {
    const cwd = join(root, 'packages', 'app');
    await mkdir(cwd, { recursive: true });
    await writeFile(join(cwd, 'local.geojson'), '{}');
    const config = resolveConfig({}, root);

    const targets = await resolveTargets(config, ['local.geojson'], cwd);

    assert.equal(targets[0]?.filePath, 'packages/app/local.geojson');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config files entries always have glob semantics', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'public'));
    await writeFile(join(root, 'public', 'map.geojson'), '{}');
    const config = resolveConfig({ files: ['public'] }, root);

    await assert.rejects(
      resolveTargets(config, undefined, root),
      (error) =>
        error instanceof GeoLintTargetError &&
        error.code === 'GEOLINT_NO_TARGETS',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit files include json and glob-metacharacter literals', async () => {
  const root = await project();
  try {
    await writeFile(join(root, 'data.json'), '{}');
    await writeFile(join(root, '[map].geojson'), '{}');
    const config = resolveConfig({}, root);

    const targets = await resolveTargets(
      config,
      ['data.json', '[map].geojson'],
      root,
    );

    assert.deepEqual(
      targets.map(({ filePath }) => filePath),
      ['[map].geojson', 'data.json'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit directories recurse into geojson files only', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'data', 'nested'), { recursive: true });
    await writeFile(join(root, 'data', 'nested', 'map.geojson'), '{}');
    await writeFile(join(root, 'data', 'nested', 'other.json'), '{}');
    const config = resolveConfig({}, root);

    const targets = await resolveTargets(config, ['data'], root);

    assert.deepEqual(
      targets.map(({ filePath }) => filePath),
      ['data/nested/map.geojson'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit unmatched globs fail intentionally', async () => {
  const root = await project();
  try {
    await assert.rejects(
      resolveTargets(resolveConfig({}, root), ['missing/**/*.geojson'], root),
      (error) =>
        error instanceof GeoLintTargetError &&
        error.code === 'GEOLINT_UNMATCHED_TARGET',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('overlapping and repeated targets deduplicate and sort deterministically', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'data'));
    await writeFile(join(root, 'data', 'z.geojson'), '{}');
    await writeFile(join(root, 'data', 'a.geojson'), '{}');
    const config = resolveConfig({}, root);

    const targets = await resolveTargets(
      config,
      ['data/*.geojson', 'data/a.geojson', 'data/*.geojson'],
      root,
    );

    assert.deepEqual(
      targets.map(({ filePath }) => filePath),
      ['data/a.geojson', 'data/z.geojson'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('config ignores filter explicit targets unless no-ignore is set', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'vendor'));
    await writeFile(join(root, 'vendor', 'map.geojson'), '{}');
    const config = resolveConfig({ ignores: ['vendor/**'] }, root);

    const ignored = await resolveTargets(config, ['vendor/map.geojson'], root);
    const included = await resolveTargets(
      config,
      ['vendor/map.geojson'],
      root,
      true,
    );

    assert.deepEqual(ignored, []);
    assert.equal(included[0]?.filePath, 'vendor/map.geojson');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('wildcards exclude dot segments and matching remains case-sensitive', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.fixtures'));
    await writeFile(join(root, '.fixtures', 'hidden.geojson'), '{}');
    await writeFile(join(root, 'Case.geojson'), '{}');

    await assert.rejects(
      resolveTargets(
        resolveConfig({ files: ['**/*.geojson'] }, root),
        undefined,
        root,
      ).then((targets) => {
        assert.deepEqual(
          targets.map(({ filePath }) => filePath),
          ['Case.geojson'],
        );
        return resolveTargets(
          resolveConfig({ files: ['case.geojson'] }, root),
          undefined,
          root,
        );
      }),
      (error) =>
        error instanceof GeoLintTargetError &&
        error.code === 'GEOLINT_NO_TARGETS',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an explicitly dot-prefixed configured pattern includes dot segments', async () => {
  const root = await project();
  try {
    await mkdir(join(root, '.fixtures'));
    await writeFile(join(root, '.fixtures', 'map.geojson'), '{}');

    const targets = await resolveTargets(
      resolveConfig({ files: ['.fixtures/**/*.geojson'] }, root),
      undefined,
      root,
    );

    assert.deepEqual(
      targets.map(({ filePath }) => filePath),
      ['.fixtures/map.geojson'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('filesystem expansion agrees with GeoLint matching for supported globs', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'public', 'nested'), { recursive: true });
    await writeFile(join(root, 'public', 'a.geojson'), '{}');
    await writeFile(join(root, 'public', 'b.geojson'), '{}');
    await writeFile(join(root, 'public', 'nested', 'a.geojson'), '{}');
    const candidates = [
      'public/a.geojson',
      'public/b.geojson',
      'public/nested/a.geojson',
    ];

    for (const pattern of ['public/[ab].geojson', 'public/**/a.geojson']) {
      const targets = await resolveTargets(
        resolveConfig({ files: [pattern] }, root),
        undefined,
        root,
      );
      assert.deepEqual(
        targets.map(({ filePath }) => filePath),
        candidates.filter((candidate) => matchesGlob(candidate, [pattern])),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('logical symlink paths remain eligible after physical identity lookup', async (t) => {
  const root = await project();
  try {
    await mkdir(join(root, 'public'));
    await mkdir(join(root, 'generated'));
    await writeFile(join(root, 'generated', 'map.geojson'), '{}');
    try {
      await symlink(
        join(root, 'generated', 'map.geojson'),
        join(root, 'public', 'current.geojson'),
        'file',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Creating file symlinks is not permitted on this host.');
        return;
      }
      throw error;
    }

    const targets = await resolveTargets(
      resolveConfig({ files: ['public/*.geojson'] }, root),
      undefined,
      root,
    );

    assert.deepEqual(
      targets.map(({ filePath }) => filePath),
      ['public/current.geojson'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stdin is retained with default identity and base policy', async () => {
  const root = await project();
  try {
    const config = resolveConfig(
      {
        rules: { base: 'error' },
        overrides: [{ files: ['public/**'], rules: { scoped: 'error' } }],
      },
      root,
    );

    const targets = await resolveTargets(config, ['-'], root);

    assert.equal(targets[0]?.kind, 'stdin');
    assert.equal(targets[0]?.filePath, '<stdin>');
    assert.equal(targets[0]?.config.rules.base, 'error');
    assert.equal(targets[0]?.config.rules.scoped, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stdin filename supplies stable identity and per-file policy', async () => {
  const root = await project();
  try {
    const config = resolveConfig(
      {
        overrides: [{ files: ['public/**'], rules: { scoped: 'error' } }],
      },
      root,
    );

    const targets = await resolveTargets(
      config,
      ['-'],
      root,
      false,
      'public/generated.geojson',
    );

    assert.equal(targets[0]?.filePath, 'public/generated.geojson');
    assert.equal(targets[0]?.config.rules.scoped, 'error');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('explicit directory symlinks are not recursively followed', async (t) => {
  const root = await project();
  try {
    await mkdir(join(root, 'source'));
    await writeFile(join(root, 'source', 'map.geojson'), '{}');
    try {
      await symlink(
        join(root, 'source'),
        join(root, 'linked-directory'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('Creating symlinks is not permitted on this host.');
        return;
      }
      throw error;
    }

    await assert.rejects(
      resolveTargets(resolveConfig({}, root), ['linked-directory'], root),
      (error) =>
        error instanceof GeoLintTargetError &&
        error.code === 'GEOLINT_UNMATCHED_TARGET',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('file aliases collapse to the lexically smallest display path', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'source'));
    await writeFile(join(root, 'source', 'map.geojson'), '{}');
    await symlink(
      join(root, 'source'),
      join(root, 'alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await symlink(
      join(root, 'source'),
      join(root, 'another-alias'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    for (const targetOrder of [
      ['source/map.geojson', 'alias/map.geojson', 'another-alias/map.geojson'],
      ['another-alias/map.geojson', 'source/map.geojson', 'alias/map.geojson'],
    ]) {
      const targets = await resolveTargets(
        resolveConfig({}, root),
        targetOrder,
        root,
      );

      assert.deepEqual(
        targets.map(({ filePath }) => filePath),
        ['alias/map.geojson'],
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded physical identity resolution preserves serial descriptors', async () => {
  const root = await project();
  try {
    await mkdir(join(root, 'data'));
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        writeFile(join(root, 'data', `${index}.geojson`), '{}'),
      ),
    );
    const config = resolveConfig(
      {
        files: ['data/**/*.geojson', 'data/*.geojson'],
        overrides: [{ files: ['data/**'], rules: { scoped: 'error' } }],
      },
      root,
    );
    const profile = (realpathConcurrency: number): TargetResolutionProfile => ({
      realpathConcurrency,
      record: () => undefined,
      count: () => undefined,
    });
    const serial = await resolveTargets(
      config,
      undefined,
      root,
      false,
      undefined,
      profile(1),
    );
    const concurrent = await resolveTargets(
      config,
      undefined,
      root,
      false,
      undefined,
      profile(8),
    );
    assert.deepEqual(concurrent, serial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
