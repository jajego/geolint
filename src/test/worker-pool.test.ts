import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WorkerPool, type WorkerLike } from '../workers/pool.js';
import type { WorkerSnapshotTask } from '../workers/protocol.js';

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

test('a permanent postMessage failure retires the slot and replacement drains the queue', async () => {
  let created = 0;
  let failedCalls = 0;
  const workers: FakeWorker[] = [];
  const pool = await WorkerPool.create(3, {
    createWorker: () => {
      created += 1;
      const workerNumber = created;
      const worker = new FakeWorker((item, current) => {
        if (workerNumber === 1) {
          failedCalls += 1;
          throw new Error('transport permanently closed');
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
    assert.deepEqual(
      outcomes.map((outcome) => outcome.type),
      [
        'error',
        'snapshot-result',
        'snapshot-result',
        'snapshot-result',
        'snapshot-result',
        'snapshot-result',
        'snapshot-result',
      ],
    );
    assert.equal(failedCalls, 1);
  } finally {
    await pool.terminate();
  }
  assert.ok(workers.every((worker) => worker.terminated));
});

test('postMessage replacement failure leaves surviving workers to drain the queue', async () => {
  let created = 0;
  let failedCalls = 0;
  const workers: FakeWorker[] = [];
  const pool = await WorkerPool.create(3, {
    createWorker: () => {
      created += 1;
      if (created === 4) throw new Error('replacement failed');
      const workerNumber = created;
      const worker = new FakeWorker((item, current) => {
        if (workerNumber === 1) {
          failedCalls += 1;
          throw new Error('transport permanently closed');
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
    assert.equal(failedCalls, 1);
    assert.equal(
      outcomes.filter((outcome) => outcome.type === 'error').length,
      1,
    );
    assert.equal(outcomes[0]?.type, 'error');
    assert.ok(
      outcomes.slice(1).every((outcome) => outcome.type === 'snapshot-result'),
    );
  } finally {
    await pool.terminate();
  }
  assert.ok(workers.every((worker) => worker.terminated));
});

test('postMessage failure with no replacement settles the pending queue once', async () => {
  let created = 0;
  let failedCalls = 0;
  const workers: FakeWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      if (created === 2) throw new Error('replacement failed');
      const worker = new FakeWorker(() => {
        failedCalls += 1;
        throw new Error('transport permanently closed');
      });
      workers.push(worker);
      return worker;
    },
  });
  try {
    const outcomes = await pool.run([task(0), task(1), task(2)]);
    assert.equal(failedCalls, 1);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.type),
      ['error', 'error', 'error'],
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
