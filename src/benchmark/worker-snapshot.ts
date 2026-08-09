import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import { captureSnapshotFile } from '../regression/snapshot.js';
import { WorkerPool } from '../workers/pool.js';
import type { WorkerSnapshotTask } from '../workers/protocol.js';
import { createFixture } from './fixtures.js';
import { median, round } from './metrics.js';

interface SnapshotWorkerResult {
  readonly workers: number;
  readonly samplesMs: readonly number[];
  readonly medianMs: number;
  readonly speedup: number;
  readonly readyMedianMs: number;
  readonly peakRssBytes: number;
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(process.cwd(), '.worker-snapshot-'));
  try {
    const fixture = createFixture('points-1m');
    const tasks = await Promise.all(
      Array.from({ length: 8 }, async (_, taskId) => {
        const filePath = `map-${taskId}.geojson`;
        const absolutePath = join(directory, filePath);
        await writeFile(absolutePath, fixture.source);
        return {
          protocolVersion: 1,
          type: 'snapshot',
          taskId,
          absolutePath,
          filePath,
        } satisfies WorkerSnapshotTask;
      }),
    );
    const results: Omit<SnapshotWorkerResult, 'speedup'>[] = [];
    for (const workers of [0, 1, 2, 4, 8]) {
      if (workers > availableParallelism()) continue;
      const execute = async () => {
        let peakRssBytes = process.memoryUsage().rss;
        const poll = setInterval(() => {
          peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
        }, 5);
        const startedAt = performance.now();
        let readyMs = 0;
        try {
          if (workers === 0) {
            for (const task of tasks)
              await captureSnapshotFile(task.absolutePath, task.filePath);
          } else {
            const readyStartedAt = performance.now();
            const pool = await WorkerPool.create(workers);
            readyMs = performance.now() - readyStartedAt;
            try {
              const outcomes = await pool.run(tasks);
              if (outcomes.some((outcome) => outcome.type === 'error'))
                throw new Error('Snapshot worker benchmark failed.');
            } finally {
              await pool.terminate();
            }
          }
          return {
            elapsedMs: performance.now() - startedAt,
            readyMs,
            peakRssBytes,
          };
        } finally {
          clearInterval(poll);
        }
      };
      await execute();
      const samples = [];
      for (let index = 0; index < 3; index += 1) samples.push(await execute());
      results.push({
        workers,
        samplesMs: samples.map((sample) => round(sample.elapsedMs)),
        medianMs: round(median(samples.map((sample) => sample.elapsedMs))),
        readyMedianMs: round(median(samples.map((sample) => sample.readyMs))),
        peakRssBytes: Math.max(...samples.map((sample) => sample.peakRssBytes)),
      });
    }
    const baseline = results[0]!.medianMs;
    const withSpeedup: SnapshotWorkerResult[] = results.map((result) => ({
      ...result,
      speedup: round(baseline / result.medianMs),
    }));
    process.stdout.write(
      `${withSpeedup
        .map(
          (result) =>
            `snapshot workers=${result.workers === 0 ? 'main' : result.workers}: ${result.medianMs.toFixed(1)} ms · ${result.speedup.toFixed(2)}× · ready ${result.readyMedianMs.toFixed(1)} ms · ${(result.peakRssBytes / 1024 / 1024).toFixed(1)} MiB RSS`,
        )
        .join('\n')}\n`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

await main();
