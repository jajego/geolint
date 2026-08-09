import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import type { FixtureId } from './fixtures.js';
import { createArtifact, formatBenchmark } from './report.js';
import { runBenchmarks, runMemoryCase, runProfileCase } from './runner.js';

const argv = process.argv.slice(2);
const memoryIndex = argv.indexOf('--memory-case');
if (memoryIndex >= 0) {
  const fixture = argv[memoryIndex + 1] as FixtureId | undefined;
  const strategy = argv[memoryIndex + 2];
  const profile = argv[memoryIndex + 3];
  if (!fixture || (strategy !== 'buffered' && strategy !== 'indexed')) {
    throw new TypeError('--memory-case requires a fixture and strategy.');
  }
  if (
    profile !== undefined &&
    profile !== 'recommended' &&
    profile !== 'source-precision'
  ) {
    throw new TypeError('--memory-case profile is invalid.');
  }
  process.stdout.write(
    `${JSON.stringify(await runMemoryCase(fixture, strategy, profile ?? 'recommended'))}\n`,
  );
} else {
  const profileIndex = argv.indexOf('--profile-case');
  if (profileIndex >= 0) {
    const id = argv[profileIndex + 1];
    if (!id)
      throw new TypeError('--profile-case requires a benchmark case ID.');
    process.stdout.write(`${JSON.stringify(await runProfileCase(id))}\n`);
  } else {
    const extended = argv.includes('--extended');
    const artifact = createArtifact(await runBenchmarks(extended), extended);
    const outputIndex = argv.indexOf('--output');
    const outputPath = outputIndex < 0 ? undefined : argv[outputIndex + 1];
    if (outputIndex >= 0 && !outputPath) {
      throw new TypeError('--output requires a JSON file path.');
    }
    if (outputPath) {
      const absolutePath = resolve(outputPath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`);
    }
    process.stdout.write(
      argv.includes('--json')
        ? `${JSON.stringify(artifact, null, 2)}\n`
        : formatBenchmark(artifact),
    );
  }
}
