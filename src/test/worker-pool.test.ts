import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { WorkerPool, type WorkerLike } from '../workers/pool.js';
import type {
  WorkerLintTask,
  WorkerResponse,
  WorkerSnapshotTask,
  WorkerTask,
} from '../workers/protocol.js';

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

class ControlledWorker extends EventEmitter implements WorkerLike {
  readonly sent: WorkerTask[] = [];
  terminated = false;

  constructor() {
    super();
    queueMicrotask(() =>
      this.emit('message', { protocolVersion: 1, type: 'ready' }),
    );
  }

  postMessage(value: WorkerTask): void {
    this.sent.push(value);
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

class DeferredWorker extends EventEmitter implements WorkerLike {
  readonly sent: WorkerTask[] = [];
  terminated = false;

  postMessage(value: WorkerTask): void {
    this.sent.push(value);
  }

  ready(): void {
    this.emit('message', { protocolVersion: 1, type: 'ready' });
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    return 0;
  }
}

class ThrowingWorker extends ControlledWorker {
  override postMessage(): void {
    throw new Error('transport permanently closed');
  }
}

function lintTask(
  taskId: number,
  sourceBytes: number,
  admission: WorkerLintTask['admission'] = 'buffered',
): WorkerLintTask {
  return {
    protocolVersion: 1,
    type: 'lint',
    taskId,
    absolutePath: `/map-${taskId}.geojson`,
    filePath: `map-${taskId}.geojson`,
    policy: {
      projectRoot: '/',
      rules: {},
      budgets: {},
      regression: {},
      diagnostics: {},
      overrides: [],
    },
    plugins: [],
    parser: admission === 'buffered-conservative-unknown' ? 'auto' : 'buffered',
    sourceBytes,
    admission,
  };
}

function lintResult(
  task: WorkerLintTask,
  parserStrategy: 'buffered' | 'indexed',
): WorkerResponse {
  return {
    protocolVersion: 1,
    type: 'lint-result',
    taskId: task.taskId,
    parserStrategy,
    result: {
      filePath: task.filePath,
      diagnostics: [],
      suppressedDiagnostics: [],
      skippedPolicies: [],
      errorCount: 0,
      warningCount: 0,
      durationMs: 0,
    },
  };
}

function workerError(task: WorkerTask): WorkerResponse {
  return {
    protocolVersion: 1,
    type: 'error',
    taskId: task.taskId,
    error: {
      name: 'Error',
      code: 'GEOLINT_INTERNAL_ERROR',
      message: 'worker operation failed',
      filePath: task.filePath,
    },
  };
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

test('buffered admission is capped while indexed work bypasses blocked FIFO work', async () => {
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(2, {
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = lintTask(0, 32 * 1024 * 1024);
  const blocked = lintTask(1, 20 * 1024 * 1024);
  const indexed = lintTask(2, 1, 'indexed');
  try {
    const running = pool.run([first, blocked, indexed]);
    assert.deepEqual(
      workers.map((worker) => worker.sent.map((task) => task.taskId)),
      [[0], [2]],
    );
    workers[1]!.emit('message', lintResult(indexed, 'indexed'));
    assert.deepEqual(
      workers[1]!.sent.map((task) => task.taskId),
      [2],
    );
    workers[0]!.emit('message', lintResult(first, 'indexed'));
    assert.deepEqual(
      workers[0]!.sent.map((task) => task.taskId),
      [0, 1],
    );
    workers[0]!.emit('message', lintResult(blocked, 'buffered'));
    assert.deepEqual(
      (await running).map((outcome) => outcome.taskId),
      [0, 1, 2],
    );
  } finally {
    await pool.terminate();
  }
});

test('only successful large actual-buffered lint work recycles a worker', async () => {
  let created = 0;
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const large = lintTask(0, 10 * 1024 * 1024);
  const next = lintTask(1, 1, 'indexed');
  try {
    const running = pool.run([large, next]);
    workers[0]!.emit('message', lintResult(large, 'buffered'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created, 2);
    assert.equal(workers[0]!.terminated, true);
    assert.deepEqual(
      workers[1]!.sent.map((task) => task.taskId),
      [1],
    );
    workers[1]!.emit('message', lintResult(next, 'indexed'));
    await running;
  } finally {
    await pool.terminate();
  }
});

test('large conservative admission that actually indexed does not recycle', async () => {
  let created = 0;
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const legacy = lintTask(0, 10 * 1024 * 1024, 'buffered-conservative-unknown');
  const next = lintTask(1, 1, 'indexed');
  try {
    const running = pool.run([legacy, next]);
    workers[0]!.emit('message', lintResult(legacy, 'indexed'));
    assert.equal(created, 1);
    assert.deepEqual(
      workers[0]!.sent.map((task) => task.taskId),
      [0, 1],
    );
    workers[0]!.emit('message', lintResult(next, 'indexed'));
    await running;
  } finally {
    await pool.terminate();
  }
});

test('under-budget buffered tasks dispatch concurrently', async () => {
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(4, {
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const tasks = Array.from({ length: 4 }, (_, taskId) =>
    lintTask(taskId, 10 * 1024 * 1024),
  );
  try {
    const running = pool.run(tasks);
    assert.deepEqual(
      workers.map((worker) => worker.sent.map((task) => task.taskId)),
      [[0], [1], [2], [3]],
    );
    for (const [index, worker] of workers.entries())
      worker.emit('message', lintResult(tasks[index]!, 'buffered'));
    await running;
  } finally {
    await pool.terminate();
  }
});

test('an oversized buffered task dispatches alone without deadlock', async () => {
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const oversized = lintTask(0, 60 * 1024 * 1024);
  try {
    const running = pool.run([oversized]);
    assert.deepEqual(
      workers[0]!.sent.map((task) => task.taskId),
      [0],
    );
    workers[0]!.emit('message', lintResult(oversized, 'buffered'));
    assert.equal((await running)[0]?.type, 'lint-result');
    assert.equal(workers.length, 1);
  } finally {
    await pool.terminate();
  }
});

test('worker error responses release buffered admission for blocked work', async () => {
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = lintTask(0, 32 * 1024 * 1024);
  const blocked = lintTask(1, 20 * 1024 * 1024);
  try {
    const running = pool.run([first, blocked]);
    workers[0]!.emit('message', workerError(first));
    assert.deepEqual(
      workers[0]!.sent.map((task) => task.taskId),
      [0, 1],
    );
    workers[0]!.emit('message', lintResult(blocked, 'buffered'));
    assert.deepEqual(
      (await running).map((outcome) => outcome.type),
      ['error', 'lint-result'],
    );
  } finally {
    await pool.terminate();
  }
});

test('postMessage failure releases buffered admission before replacement dispatch', async () => {
  let created = 0;
  const replacements: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      if (created === 1) return new ThrowingWorker();
      const replacement = new ControlledWorker();
      replacements.push(replacement);
      return replacement;
    },
  });
  const first = lintTask(0, 32 * 1024 * 1024);
  const blocked = lintTask(1, 20 * 1024 * 1024);
  try {
    const running = pool.run([first, blocked]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      replacements[0]!.sent.map((task) => task.taskId),
      [1],
    );
    replacements[0]!.emit('message', lintResult(blocked, 'buffered'));
    assert.deepEqual(
      (await running).map((outcome) => outcome.type),
      ['error', 'lint-result'],
    );
  } finally {
    await pool.terminate();
  }
});

test('unexpected exit releases buffered admission before replacement dispatch', async () => {
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const first = lintTask(0, 32 * 1024 * 1024);
  const blocked = lintTask(1, 20 * 1024 * 1024);
  try {
    const running = pool.run([first, blocked]);
    workers[0]!.emit('exit', 7);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      workers[1]!.sent.map((task) => task.taskId),
      [1],
    );
    workers[1]!.emit('message', lintResult(blocked, 'buffered'));
    assert.deepEqual(
      (await running).map((outcome) => outcome.type),
      ['error', 'lint-result'],
    );
  } finally {
    await pool.terminate();
  }
});

test('a final qualifying buffered task does not start a replacement', async () => {
  let created = 0;
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const finalTask = lintTask(0, 10 * 1024 * 1024);
  try {
    const running = pool.run([finalTask]);
    workers[0]!.emit('message', lintResult(finalTask, 'buffered'));
    assert.equal((await running)[0]?.type, 'lint-result');
    assert.equal(created, 1);
  } finally {
    await pool.terminate();
  }
});

test('a conservative legacy task that actually buffers recycles successfully', async () => {
  let created = 0;
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const legacy = lintTask(0, 10 * 1024 * 1024, 'buffered-conservative-unknown');
  const next = lintTask(1, 1, 'indexed');
  try {
    const running = pool.run([legacy, next]);
    workers[0]!.emit('message', lintResult(legacy, 'buffered'));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(created, 2);
    assert.equal(workers[0]!.terminated, true);
    workers[1]!.emit('message', lintResult(next, 'indexed'));
    assert.deepEqual(
      (await running).map((outcome) => outcome.type),
      ['lint-result', 'lint-result'],
    );
  } finally {
    await pool.terminate();
  }
});

test('voluntary replacement failure preserves success while survivors drain', async () => {
  let created = 0;
  const workers: ControlledWorker[] = [];
  const pool = await WorkerPool.create(2, {
    createWorker: () => {
      created += 1;
      if (created === 3) throw new Error('replacement failed');
      const worker = new ControlledWorker();
      workers.push(worker);
      return worker;
    },
  });
  const large = lintTask(0, 10 * 1024 * 1024);
  const active = lintTask(1, 1, 'indexed');
  const pending = lintTask(2, 1, 'indexed');
  try {
    const running = pool.run([large, active, pending]);
    workers[0]!.emit('message', lintResult(large, 'buffered'));
    await new Promise((resolve) => setImmediate(resolve));
    workers[1]!.emit('message', lintResult(active, 'indexed'));
    assert.deepEqual(
      workers[1]!.sent.map((task) => task.taskId),
      [1, 2],
    );
    workers[1]!.emit('message', lintResult(pending, 'indexed'));
    assert.deepEqual(
      (await running).map((outcome) => outcome.type),
      ['lint-result', 'lint-result', 'lint-result'],
    );
  } finally {
    await pool.terminate();
  }
});

test('shutdown terminates a worker that becomes ready during replacement', async () => {
  let created = 0;
  const initial = new ControlledWorker();
  const replacement = new DeferredWorker();
  const pool = await WorkerPool.create(1, {
    createWorker: () => {
      created += 1;
      return created === 1 ? initial : replacement;
    },
  });
  const large = lintTask(0, 10 * 1024 * 1024);
  const pending = lintTask(1, 1, 'indexed');
  const running = pool.run([large, pending]);
  initial.emit('message', lintResult(large, 'buffered'));
  const closing = pool.terminate();
  replacement.ready();
  await closing;
  assert.equal(replacement.terminated, true);
  void running;
});
