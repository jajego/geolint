import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../config/resolve.js';
import {
  resolveTargets,
  type TargetResolutionProfile,
} from '../engine/targets.js';

const cases = [
  ['small', 120, 40],
  ['medium', 5000, 500],
  ['sparse', 50000, 500],
  ['matches', 10000, 10000],
  ['deep', 1000, 500],
  ['wide', 10000, 1000],
  ['overlap', 5000, 1000],
] as const;
for (const [name, total, matches] of cases) {
  const root = await mkdtemp(join(tmpdir(), 'geolint-profile-'));
  try {
    const files = Array.from({ length: total }, (_, i) => {
      let dir = join(root, 'data', `g${i % 50}`);
      if (name === 'deep')
        dir = join(
          root,
          'data',
          ...Array.from({ length: 12 }, (_, d) => `d${d}`),
          `g${i % 20}`,
        );
      else if (name === 'wide') dir = join(root, 'data');
      return [
        dir,
        join(dir, `f${i}.${i < matches ? 'geojson' : 'txt'}`),
      ] as const;
    });
    await Promise.all(
      [...new Set(files.map(([d]) => d))].map((d) =>
        mkdir(d, { recursive: true }),
      ),
    );
    for (let i = 0; i < files.length; i += 500)
      await Promise.all(
        files.slice(i, i + 500).map(([, p]) => writeFile(p, '{}')),
      );
    const patterns =
      name === 'overlap'
        ? ['data/**/*.geojson', 'data/g*/**/*.geojson']
        : ['data/**/*.geojson'];
    const config = resolveConfig({ files: patterns }, root);
    const results = [];
    for (const realpathConcurrency of [1, 2, 4, 8, 16, 32]) {
      const samples = [];
      for (let run = 0; run < 4; run++) {
        const phases = new Map<string, number>(),
          counts = new Map<string, number>();
        const profile: TargetResolutionProfile = {
          realpathConcurrency,
          record: (k, v) => phases.set(k, (phases.get(k) ?? 0) + v),
          count: (k, v = 1) => counts.set(k, (counts.get(k) ?? 0) + v),
        };
        await resolveTargets(
          config,
          undefined,
          root,
          false,
          undefined,
          profile,
        );
        if (run)
          samples.push({
            phases: Object.fromEntries(phases),
            counts: Object.fromEntries(counts),
          });
      }
      results.push({ realpathConcurrency, samples });
    }
    console.log(JSON.stringify({ name, results }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
