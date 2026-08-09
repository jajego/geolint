import { Worker } from 'node:worker_threads';

import type {
  WorkerResponse,
  WorkerTask,
  WorkerTaskOutcome,
} from './protocol.js';

interface Slot {
  worker: Worker;
  active: WorkerTask | undefined;
  failed: boolean;
}

function internalError(task: WorkerTask, message: string): WorkerTaskOutcome {
  return {
    protocolVersion: 1,
    type: 'error',
    taskId: task.taskId,
    error: {
      name: 'GeoLintInternalError',
      code: 'GEOLINT_WORKER_FAILURE',
      message,
      filePath: task.filePath,
    },
  };
}

function readyWorker(): Promise<Worker> {
  const worker = new Worker(new URL('./worker-entry.js', import.meta.url), {
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off('message', ready);
      worker.off('error', failed);
      worker.off('exit', exited);
    };
    const ready = (message: WorkerResponse) => {
      if (message.protocolVersion !== 1 || message.type !== 'ready') {
        failed(new Error('Worker returned an invalid startup message.'));
        return;
      }
      cleanup();
      resolve(worker);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number) => {
      failed(new Error(`Worker exited during startup (${code}).`));
    };
    worker.on('message', ready);
    worker.once('error', failed);
    worker.once('exit', exited);
  });
}

export class WorkerPool {
  readonly #slots: Slot[] = [];
  firstTaskMs = 0;

  private constructor() {}

  static async create(size: number): Promise<WorkerPool> {
    const pool = new WorkerPool();
    try {
      const started = await Promise.allSettled(
        Array.from({ length: size }, () => readyWorker()),
      );
      pool.#slots.push(
        ...started.flatMap((result) =>
          result.status === 'fulfilled'
            ? [{ worker: result.value, active: undefined, failed: false }]
            : [],
        ),
      );
      const failure = started.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      return pool;
    } catch (error) {
      await pool.terminate();
      throw error;
    }
  }

  run(tasks: readonly WorkerTask[]): Promise<readonly WorkerTaskOutcome[]> {
    if (tasks.length === 0) return Promise.resolve([]);
    return new Promise((resolve) => {
      const startedAt = performance.now();
      const outcomes: Array<WorkerTaskOutcome | undefined> = Array.from({
        length: tasks.length,
      });
      let next = 0;
      let settled = 0;
      let finished = false;

      const complete = (outcome: WorkerTaskOutcome) => {
        if (outcomes[outcome.taskId]) return;
        outcomes[outcome.taskId] = outcome;
        settled += 1;
        if (settled === tasks.length) {
          finished = true;
          cleanup();
          resolve(outcomes as WorkerTaskOutcome[]);
        }
      };
      const cleanup = () => {
        for (const slot of this.#slots) {
          slot.worker.removeAllListeners('message');
          slot.worker.removeAllListeners('error');
          slot.worker.removeAllListeners('exit');
        }
      };
      const dispatch = (slot: Slot) => {
        if (finished || slot.failed) return;
        const task = tasks[next];
        next += 1;
        if (!task) return;
        slot.active = task;
        slot.worker.postMessage(task);
      };
      const replace = async (slot: Slot) => {
        if (finished || next >= tasks.length) return;
        try {
          const worker = await readyWorker();
          if (finished || next >= tasks.length) {
            await worker.terminate();
            return;
          }
          slot.worker = worker;
          slot.failed = false;
          attach(slot);
          dispatch(slot);
        } catch (error) {
          while (next < tasks.length) {
            const task = tasks[next++]!;
            complete(
              internalError(
                task,
                `Worker replacement failed: ${String(error)}`,
              ),
            );
          }
        }
      };
      const crash = (slot: Slot, message: string) => {
        if (slot.failed || finished) return;
        slot.failed = true;
        if (slot.active) complete(internalError(slot.active, message));
        slot.active = undefined;
        void replace(slot);
      };
      const attach = (slot: Slot) => {
        slot.worker.on('message', (message: WorkerResponse) => {
          if (
            message.protocolVersion !== 1 ||
            message.type === 'ready' ||
            !slot.active ||
            message.taskId !== slot.active.taskId
          ) {
            crash(slot, 'Worker returned an invalid protocol message.');
            return;
          }
          complete(message);
          if (this.firstTaskMs === 0)
            this.firstTaskMs = performance.now() - startedAt;
          slot.active = undefined;
          dispatch(slot);
        });
        slot.worker.once('error', (error) => crash(slot, error.message));
        slot.worker.once('exit', (code) => {
          crash(slot, `Worker exited unexpectedly (${code}).`);
        });
      };

      for (const slot of this.#slots) {
        attach(slot);
        dispatch(slot);
      }
    });
  }

  async terminate(): Promise<void> {
    const workers = this.#slots.splice(0).map((slot) => slot.worker);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
