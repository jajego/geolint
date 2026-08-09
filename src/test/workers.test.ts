import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parseCliArguments } from '../cli/args.js';
import {
  executeLintFiles,
  type BatchExecutionOptions,
} from '../engine/lint-files.js';
import {
  GeoLintBatchError,
  GeoLintCapabilityError,
  GeoLintPluginError,
} from '../engine/errors.js';
import { definePlugin } from '../plugins/plugin.js';
import { snapshotBaseline } from '../regression/snapshot.js';
import { snapshotWorkerCount } from '../regression/snapshot.js';
import { WorkerPool, type WorkerLike } from '../workers/pool.js';
import type { WorkerSnapshotTask } from '../workers/protocol.js';
import { namedPlugin } from './fixtures/external-plugin.js';
import workerPlugin from './fixtures/worker-plugin.js';

function stable(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, item) => (key === 'durationMs' ? 0 : item)),
  );
}

async function project(files = 4, padding = 0): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'geolint-workers-'));
  await Promise.all(
    Array.from({ length: files }, (_, index) =>
      writeFile(
        join(directory, `map-${index}.geojson`),
        JSON.stringify({
          type: 'Feature',
          id: index,
          properties: {
            name: `map-${index}`,
            ...(padding ? { padding: 'x'.repeat(padding) } : {}),
          },
          geometry: { type: 'Point', coordinates: [index, index] },
        }),
      ),
    ),
  );
  return directory;
}

function task(taskId: number): WorkerSnapshotTask {
  return {
    protocolVersion: 1,
    type: 'snapshot',
    taskId,
    absolutePath: `/map-${taskId}.geojson`,
    filePath: `map-${taskId}.geojson`,
  };
}

class FakeWorker extends EventEmitter implements WorkerLike {
  terminated = false;

  constructor(
    private readonly send: (
      task: WorkerSnapshotTask,
      worker: FakeWorker,
    ) => void,
  ) {
    super();
    queueMicrotask(() =>
      this.emit('message', { protocolVersion: 1, type: 'ready' }),
    );
  }

  postMessage(value: WorkerSnapshotTask): void {
    this.send(value, this);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

function succeed(
  task: WorkerSnapshotTask,
  worker: FakeWorker,
  delay = 0,
): void {
  setTimeout(
    () =>
      worker.emit('message', {
        protocolVersion: 1,
        type: 'snapshot-result',
        taskId: task.taskId,
        result: {
          bytes: 1,
          featureCount: 0,
          totalVertices: 0,
          largestFeatureVertices: 0,
          featureGeometryTypes: {},
          properties: {},
          ids: { missing: 0, duplicates: 0, string: 0, number: 0 },
          nullGeometries: 0,
        },
      }),
    delay,
  );
}

test('worker counts preserve built-in, override, and source-aware semantics', async () => {
  const directory = await project();
  const options: BatchExecutionOptions = {
    cwd: directory,
    targets: ['*.geojson'],
    config: {
      rules: { 'valid-coordinate-range': 'error' },
      budgets: { featureCount: 1, feature: { bytes: '1MB' } },
      overrides: [
        {
          files: ['map-1.geojson'],
          rules: { 'coordinate-precision': 'warn' },
        },
      ],
    },
  };
  try {
    const sequential = await executeLintFiles({ ...options, workers: 1 });
    for (const workers of [2, 4]) {
      const parallel = await executeLintFiles({ ...options, workers });
      assert.deepEqual(stable(parallel), stable(sequential));
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('workers reload plugins, preserve options, and isolate listener state', async () => {
  const directory = await project();
  try {
    const config = {
      plugins: { worker: workerPlugin, named: namedPlugin },
      rules: {
        'worker/property-required': ['error', { key: 'missing' }],
        'worker/isolated-coordinates': 'error',
        'worker/property-hook': 'warn',
      },
    } as const;
    const sequential = await executeLintFiles({
      cwd: directory,
      targets: ['*.geojson'],
      config,
      workers: 1,
    });
    const parallel = await executeLintFiles({
      cwd: directory,
      targets: ['*.geojson'],
      config,
      workers: 2,
    });
    assert.deepEqual(stable(parallel), stable(sequential));
    assert.equal(parallel.errorCount, 4);
    assert.equal(parallel.warningCount, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('inline plugins fall back automatically and reject explicit parallelism', async () => {
  const directory = await project();
  const inline = definePlugin({ meta: { apiVersion: 1 }, rules: {} });
  const debug: string[] = [];
  try {
    await executeLintFiles({
      cwd: directory,
      targets: ['*.geojson'],
      config: { plugins: { local: inline } },
      debug: (message) => debug.push(message),
    });
    assert.ok(debug.includes('effective workers: 1'));
    assert.ok(
      debug.includes('worker reason: plugin "local" is not reloadable'),
    );
    await assert.rejects(
      executeLintFiles({
        cwd: directory,
        targets: ['*.geojson'],
        config: { plugins: { local: inline } },
        workers: 2,
      }),
      GeoLintCapabilityError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker plugin failures retain class, code, rule, file, and cause', async () => {
  const directory = await project(2);
  try {
    await assert.rejects(
      executeLintFiles({
        cwd: directory,
        targets: ['*.geojson'],
        config: {
          plugins: { worker: workerPlugin },
          rules: { 'worker/throwing': 'error' },
        },
        workers: 2,
      }),
      (error) => {
        assert.ok(error instanceof GeoLintBatchError);
        assert.equal(error.errors.length, 2);
        for (const item of error.errors) {
          assert.ok(item instanceof GeoLintPluginError);
          assert.equal(item.code, 'GEOLINT_PLUGIN_ERROR');
          assert.equal(item.ruleId, 'worker/throwing');
          assert.match(item.filePath, /^map-/);
          assert.match(String(item.cause), /worker plugin failed/);
          assert.match(item.stack ?? '', /explodeInsideWorkerPlugin/);
        }
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uncloneable worker tasks fall back automatically, fail explicitly, and allow workers=1', async () => {
  const directory = await project(4, 5_000_000);
  const cloneableConfig = {
    plugins: { worker: workerPlugin },
    rules: {
      'worker/clone-options': [
        'error',
        {
          text: 'value',
          number: 1,
          boolean: true,
          empty: null,
          list: ['value', 1, false, null],
          nested: { value: ['nested'] },
        },
      ],
    },
  } as const;
  const config = {
    plugins: { worker: workerPlugin },
    rules: {
      'worker/clone-options': ['error', { callback: () => {} }],
    },
  } as const;
  const debug: string[] = [];
  try {
    assert.equal(
      (
        await executeLintFiles({
          cwd: directory,
          targets: ['*.geojson'],
          config: cloneableConfig,
          workers: 2,
        })
      ).files.length,
      4,
    );
    const sequential = await executeLintFiles({
      cwd: directory,
      targets: ['*.geojson'],
      config,
      workers: 1,
    });
    const automatic = await executeLintFiles({
      cwd: directory,
      targets: ['*.geojson'],
      config,
      debug: (message) => debug.push(message),
    });
    assert.deepEqual(stable(automatic), stable(sequential));
    assert.ok(
      debug.includes(
        'Worker parallelism disabled because the resolved worker task is not structured-clone-safe.',
      ),
    );
    await assert.rejects(
      executeLintFiles({
        cwd: directory,
        targets: ['*.geojson'],
        config,
        workers: 2,
      }),
      (error) =>
        error instanceof GeoLintCapabilityError &&
        error.code === 'GEOLINT_CAPABILITY_WORKER_TASK_NOT_CLONEABLE',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot worker count remains explicit and clamps to system parallelism', () => {
  assert.equal(snapshotWorkerCount(undefined, 100, 8), 1);
  assert.equal(snapshotWorkerCount(1, 100, 8), 1);
  assert.equal(snapshotWorkerCount(1_000, 100, 8), 8);
});

test('postMessage failures settle once and leave the worker scheduler alive', async () => {
  let calls = 0;
  const workers: FakeWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      const worker = new FakeWorker((item, current) => {
        calls += 1;
        if (calls === 2) throw new Error('dispatch failed');
        succeed(item, current);
      });
      workers.push(worker);
      return worker;
    },
  });
  try {
    const outcomes = await pool.run([task(0), task(1), task(2)]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.type),
      ['snapshot-result', 'error', 'snapshot-result'],
    );
    assert.equal(
      outcomes[1]?.type === 'error' && outcomes[1].error.code,
      'GEOLINT_WORKER_FAILURE',
    );
  } finally {
    await pool.terminate();
  }
  assert.ok(workers.every((worker) => worker.terminated));
});

test('replacement startup failure degrades the pool while survivors drain queued tasks', async () => {
  let created = 0;
  const workers: FakeWorker[] = [];
  const pool = await WorkerPool.create(3, {
    createWorker: () => {
      created += 1;
      if (created === 4) throw new Error('replacement failed');
      const workerNumber = created;
      const worker = new FakeWorker((item, current) => {
        if (workerNumber === 2) {
          queueMicrotask(() => current.emit('exit', 7));
          return;
        }
        succeed(item, current, 5);
      });
      workers.push(worker);
      return worker;
    },
  });
  try {
    const outcomes = await pool.run(
      Array.from({ length: 7 }, (_, index) => task(index)),
    );
    assert.equal(
      outcomes.filter((outcome) => outcome.type === 'error').length,
      1,
    );
    assert.equal(outcomes[1]?.type, 'error');
    assert.ok(
      outcomes.filter((outcome) => outcome.type === 'snapshot-result')
        .length === 6,
    );
  } finally {
    await pool.terminate();
  }
  assert.ok(workers.every((worker) => worker.terminated));
});

test('replacement startup failure settles pending tasks when no workers survive', async () => {
  let created = 0;
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      if (created === 2) throw new Error('replacement failed');
      return new FakeWorker((_item, worker) => {
        queueMicrotask(() => worker.emit('exit', 7));
      });
    },
  });
  try {
    const outcomes = await pool.run([task(0), task(1), task(2)]);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.type),
      ['error', 'error', 'error'],
    );
    assert.ok(
      outcomes.every(
        (outcome) =>
          outcome.type === 'error' &&
          outcome.error.code === 'GEOLINT_WORKER_FAILURE',
      ),
    );
  } finally {
    await pool.terminate();
  }
});

test('a crashed worker settles its task and remaining targets finish', async () => {
  const directory = await project(3);
  try {
    await assert.rejects(
      executeLintFiles({
        cwd: directory,
        targets: ['*.geojson'],
        config: {
          plugins: { worker: workerPlugin },
          rules: { 'worker/crashing': 'off' },
          overrides: [
            {
              files: ['map-0.geojson'],
              rules: { 'worker/crashing': 'error' },
            },
            {
              files: ['map-1.geojson'],
              rules: { 'worker/crashing': 'error' },
            },
          ],
        },
        workers: 2,
      }),
      (error) => {
        assert.ok(error instanceof GeoLintBatchError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0]?.code, 'GEOLINT_WORKER_FAILURE');
        assert.deepEqual(
          error.partialResult.files.map((file) => file.filePath),
          ['map-2.geojson'],
        );
        return true;
      },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot workers ignore inline plugins and keep writes on the main thread', async () => {
  const directory = await project(2);
  const inline = definePlugin({ meta: { apiVersion: 1 }, rules: {} });
  try {
    const result = await snapshotBaseline({
      cwd: directory,
      targets: ['*.geojson'],
      config: { plugins: { local: inline } },
      workers: 2,
    });
    assert.equal(result.proposal.added.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('worker CLI counts validate strictly', () => {
  assert.equal(parseCliArguments(['--workers', '1', 'map.geojson']).workers, 1);
  assert.equal(parseCliArguments(['--workers', '8', 'map.geojson']).workers, 8);
  for (const value of ['0', '-1', '1.5', 'x'])
    assert.throws(() => parseCliArguments(['--workers', value, 'map.geojson']));
  assert.throws(() => parseCliArguments(['--workers']));
});

test('configuration executes on the main thread only', async () => {
  const directory = await project(2);
  const configPath = join(directory, 'geolint.config.mjs');
  try {
    await writeFile(
      configPath,
      `import { isMainThread } from 'node:worker_threads';
if (!isMainThread) throw new Error('config loaded in Worker');
export default { rules: { 'valid-coordinate-range': 'error' } };
`,
    );
    const result = await executeLintFiles({
      cwd: directory,
      targets: ['*.geojson'],
      config: configPath,
      workers: 2,
    });
    assert.equal(result.files.length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('regression baseline results are worker-count invariant', async () => {
  const directory = await project(3);
  try {
    await snapshotBaseline({
      cwd: directory,
      targets: ['*.geojson'],
      config: {},
    });
    const options: BatchExecutionOptions = {
      cwd: directory,
      targets: ['*.geojson'],
      config: {
        regression: {
          thresholds: { totalVerticesIncrease: { percentage: 0 } },
        },
      },
    };
    assert.deepEqual(
      stable(await executeLintFiles({ ...options, workers: 2 })),
      stable(await executeLintFiles({ ...options, workers: 1 })),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('parallel partial failures preserve canonical result and error order', async () => {
  const directory = await project(4);
  try {
    await writeFile(join(directory, 'map-1.geojson'), '{');
    const options: BatchExecutionOptions = {
      cwd: directory,
      targets: ['*.geojson'],
      config: {
        plugins: { worker: workerPlugin },
        rules: { 'worker/throwing': 'off' },
        overrides: [
          {
            files: ['map-2.geojson'],
            rules: { 'worker/throwing': 'error' },
          },
        ],
      },
    };
    const capture = async (workers: number) => {
      try {
        await executeLintFiles({ ...options, workers });
        assert.fail('Expected a plugin failure.');
      } catch (error) {
        assert.ok(error instanceof GeoLintBatchError);
        return {
          files: stable(error.partialResult.files),
          errors: error.errors.map((item) => ({
            code: item.code,
            message: item.message,
            ruleId:
              item instanceof GeoLintPluginError ? item.ruleId : undefined,
          })),
        };
      }
    };
    assert.deepEqual(await capture(2), await capture(1));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('snapshot worker failure preserves the baseline byte-for-byte', async () => {
  const directory = await project(2);
  const baselinePath = join(directory, '.geolint-baseline.json');
  try {
    await snapshotBaseline({
      cwd: directory,
      targets: ['*.geojson'],
      config: {},
    });
    const before = await readFile(baselinePath, 'utf8');
    await writeFile(join(directory, 'map-1.geojson'), '{');
    await assert.rejects(
      snapshotBaseline({
        cwd: directory,
        targets: ['*.geojson'],
        config: {},
        workers: 2,
      }),
    );
    assert.equal(await readFile(baselinePath, 'utf8'), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
