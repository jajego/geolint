import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../config/resolve.js';
import { resolveTargets } from '../cli/targets.js';

test('target expansion is deterministic and honors config ignores', async () => {
  const root = await mkdtemp(join(tmpdir(), 'geolint-targets-'));
  try {
    await mkdir(join(root, 'public', 'vendor'), { recursive: true });
    await writeFile(join(root, 'public', 'z.geojson'), '{}');
    await writeFile(join(root, 'public', 'a.geojson'), '{}');
    await writeFile(join(root, 'public', 'vendor', 'ignored.geojson'), '{}');
    const config = resolveConfig(
      { files: ['public/**/*.geojson'], ignores: ['public/vendor/**'] },
      root,
    );

    const targets = await resolveTargets(config, undefined, root);

    assert.deepEqual(
      targets.map((target) => target.filePath),
      ['public/a.geojson', 'public/z.geojson'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
