import { Worker } from 'node:worker_threads';

import type { ResolvedConfig } from '../types/config.js';
import type { FileLintResult } from '../types/semantic.js';
import type { ParserStrategy } from '../engine/lint-input.js';
import type { BaselineFileEntry } from '../regression/schema.js';

export interface PrototypeWorkerTask {
  readonly protocolVersion: 1;
  readonly taskId: number;
  readonly absolutePath: string;
  readonly filePath: string;
  readonly config: ResolvedConfig;
  readonly parser: ParserStrategy;
  readonly baseline?: BaselineFileEntry;
}

export type PrototypeWorkerMessage =
  | { readonly protocolVersion: 1; readonly type: 'ready' }
  | {
      readonly protocolVersion: 1;
      readonly type: 'result';
      readonly taskId: number;
      readonly result: FileLintResult;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: 'error';
      readonly taskId: number;
      readonly message: string;
    };

function waitUntilReady(worker: Worker): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = (message: PrototypeWorkerMessage) => {
      if (message.protocolVersion !== 1 || message.type !== 'ready') return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      worker.off('message', ready);
      worker.off('error', failed);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    worker.on('message', ready);
    worker.once('error', failed);
  });
}

export class PrototypeWorkerPool {
  readonly readyMs: number;
  readonly #workers: readonly Worker[];

  private constructor(workers: readonly Worker[], readyMs: number) {
    this.#workers = workers;
    this.readyMs = readyMs;
  }

  static async create(size: number): Promise<PrototypeWorkerPool> {
    const startedAt = performance.now();
    const workers = Array.from(
      { length: size },
      () => new Worker(new URL('./worker-prototype-entry.js', import.meta.url)),
    );
    try {
      await Promise.all(workers.map(waitUntilReady));
      return new PrototypeWorkerPool(workers, performance.now() - startedAt);
    } catch (error) {
      await Promise.all(workers.map((worker) => worker.terminate()));
      throw error;
    }
  }

  run(tasks: readonly PrototypeWorkerTask[]): Promise<{
    readonly results: readonly FileLintResult[];
    readonly elapsedMs: number;
    readonly firstTaskMs: number;
  }> {
    if (tasks.length === 0)
      return Promise.resolve({ results: [], elapsedMs: 0, firstTaskMs: 0 });
    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const results: FileLintResult[] = Array.from({ length: tasks.length });
      let next = 0;
      let completed = 0;
      let firstTaskMs = 0;
      let settled = false;

      const cleanup = () => {
        for (const worker of this.#workers) {
          worker.off('message', receive);
          worker.off('error', fail);
        }
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const dispatch = (worker: Worker) => {
        const task = tasks[next];
        next += 1;
        if (task) worker.postMessage({ type: 'task', task });
      };
      const receive = function (this: Worker, message: PrototypeWorkerMessage) {
        if (message.protocolVersion !== 1 || message.type === 'ready') return;
        if (message.type === 'error') {
          fail(
            new Error(
              `Worker task ${message.taskId} failed: ${message.message}`,
            ),
          );
          return;
        }
        if (firstTaskMs === 0) firstTaskMs = performance.now() - startedAt;
        results[message.taskId] = message.result;
        completed += 1;
        if (completed === tasks.length) {
          settled = true;
          cleanup();
          resolve({
            results,
            elapsedMs: performance.now() - startedAt,
            firstTaskMs,
          });
          return;
        }
        dispatch(this);
      };

      for (const worker of this.#workers) {
        worker.on('message', receive);
        worker.once('error', fail);
        dispatch(worker);
      }
    });
  }

  async terminate(): Promise<void> {
    await Promise.all(this.#workers.map((worker) => worker.terminate()));
  }
}
