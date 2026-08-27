import { Worker } from 'node:worker_threads';

import type {
  WorkerResponse,
  WorkerTask,
  WorkerTaskOutcome,
} from './protocol.js';

// Aggregate admission policy for buffered source bytes; this is not an RSS ceiling.
const BUFFERED_CONCURRENCY_BYTE_BUDGET = 48 * 1024 * 1024;
// Retire isolates after buffered tasks large enough to retain substantial committed heap.
const BUFFERED_WORKER_RECYCLE_THRESHOLD = 10 * 1024 * 1024;

export interface WorkerLike {
  on(event: 'message', listener: (message: WorkerResponse) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  off(event: 'message', listener: (message: WorkerResponse) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'exit', listener: (code: number) => void): unknown;
  postMessage(value: WorkerTask): void;
  terminate(): Promise<number>;
}

interface ActiveTask {
  readonly task: WorkerTask;
  readonly bufferedBytes: number;
}

interface SlotListeners {
  readonly message: (message: WorkerResponse) => void;
  readonly error: (error: Error) => void;
  readonly exit: (code: number) => void;
}

interface Slot {
  worker: WorkerLike;
  active: ActiveTask | undefined;
  failed: boolean;
  replacing: boolean;
  listeners: SlotListeners | undefined;
}

export interface WorkerPoolOptions {
  readonly createWorker?: () => WorkerLike;
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

function createNativeWorker(): Worker {
  const worker = new Worker(new URL('./worker-entry.js', import.meta.url), {
    stdout: true,
    stderr: true,
  });
  worker.stdout.resume();
  worker.stderr.resume();
  return worker;
}

function readyWorker(createWorker: () => WorkerLike): Promise<WorkerLike> {
  let worker: WorkerLike;
  try {
    worker = createWorker();
  } catch (error) {
    return Promise.reject(error);
  }
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

function bufferedCost(task: WorkerTask): number {
  return task.type === 'lint' && task.admission !== 'indexed'
    ? task.sourceBytes
    : 0;
}

function validOutcome(task: WorkerTask, message: WorkerResponse): boolean {
  if (message.type === 'error') return true;
  return (
    (task.type === 'lint' && message.type === 'lint-result') ||
    (task.type === 'snapshot' && message.type === 'snapshot-result')
  );
}

function detachSlot(slot: Slot): void {
  const listeners = slot.listeners;
  if (!listeners) return;
  slot.worker.off('message', listeners.message);
  slot.worker.off('error', listeners.error);
  slot.worker.off('exit', listeners.exit);
  slot.listeners = undefined;
}

export class WorkerPool {
  readonly #slots: Slot[] = [];
  readonly #createWorker: () => WorkerLike;
  readonly #starting = new Set<Promise<void>>();
  #shuttingDown = false;
  firstTaskMs = 0;

  private constructor(createWorker: () => WorkerLike) {
    this.#createWorker = createWorker;
  }

  static async create(
    size: number,
    options: WorkerPoolOptions = {},
  ): Promise<WorkerPool> {
    const pool = new WorkerPool(options.createWorker ?? createNativeWorker);
    try {
      const started = await Promise.allSettled(
        Array.from({ length: size }, () => readyWorker(pool.#createWorker)),
      );
      pool.#slots.push(
        ...started.flatMap((result) =>
          result.status === 'fulfilled'
            ? [
                {
                  worker: result.value,
                  active: undefined,
                  failed: false,
                  replacing: false,
                  listeners: undefined,
                },
              ]
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
      const pending = [...tasks];
      const outcomes: Array<WorkerTaskOutcome | undefined> = Array.from({
        length: tasks.length,
      });
      let activeBufferedBytes = 0;
      let settled = 0;
      let finished = false;

      const cleanup = () => this.#slots.forEach(detachSlot);
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
      const finishActive = (slot: Slot): ActiveTask | undefined => {
        const active = slot.active;
        if (!active) return undefined;
        slot.active = undefined;
        activeBufferedBytes -= active.bufferedBytes;
        if (activeBufferedBytes < 0)
          throw new Error('Worker buffered admission accounting underflow.');
        return active;
      };
      const eligible = (task: WorkerTask): boolean => {
        const bytes = bufferedCost(task);
        return (
          bytes === 0 ||
          (bytes > BUFFERED_CONCURRENCY_BYTE_BUDGET
            ? activeBufferedBytes === 0
            : activeBufferedBytes + bytes <= BUFFERED_CONCURRENCY_BYTE_BUDGET)
        );
      };
      const nextEligible = (): WorkerTask | undefined => {
        const index = pending.findIndex(eligible);
        return index < 0 ? undefined : pending.splice(index, 1)[0];
      };
      const failPendingIfUnusable = () => {
        if (
          finished ||
          pending.length === 0 ||
          this.#slots.some((slot) => !slot.failed || slot.replacing)
        )
          return;
        for (const task of pending.splice(0))
          complete(internalError(task, 'No GeoLint Workers are available.'));
      };
      let schedule = (): void => undefined;
      const startReplacement = (slot: Slot) => {
        slot.replacing = true;
        const starting = (async () => {
          try {
            const worker = await readyWorker(this.#createWorker);
            if (this.#shuttingDown || finished) {
              await worker.terminate();
              return;
            }
            slot.worker = worker;
            slot.failed = false;
            slot.replacing = false;
            attach(slot);
            schedule();
          } catch {
            slot.replacing = false;
            slot.failed = true;
            failPendingIfUnusable();
          }
        })();
        this.#starting.add(starting);
        void starting.finally(() => this.#starting.delete(starting));
      };
      const crash = (slot: Slot, message: string) => {
        if (slot.failed || finished) return;
        const active = finishActive(slot);
        slot.failed = true;
        detachSlot(slot);
        if (active) complete(internalError(active.task, message));
        void slot.worker.terminate().catch(() => undefined);
        if (!finished && pending.length > 0) startReplacement(slot);
        schedule();
        failPendingIfUnusable();
      };
      const recycle = (slot: Slot) => {
        slot.failed = true;
        detachSlot(slot);
        void slot.worker.terminate().catch(() => undefined);
        startReplacement(slot);
      };
      const dispatch = (slot: Slot) => {
        if (finished || slot.failed || slot.replacing || slot.active) return;
        const task = nextEligible();
        if (!task) return;
        const bufferedBytes = bufferedCost(task);
        activeBufferedBytes += bufferedBytes;
        slot.active = { task, bufferedBytes };
        try {
          slot.worker.postMessage(task);
        } catch (error) {
          crash(slot, `Could not dispatch Worker task: ${String(error)}`);
        }
      };
      schedule = () => {
        if (finished) return;
        for (const slot of this.#slots) dispatch(slot);
        failPendingIfUnusable();
      };
      const attach = (slot: Slot) => {
        const message = (response: WorkerResponse) => {
          const active = slot.active;
          if (
            response.protocolVersion !== 1 ||
            response.type === 'ready' ||
            !active ||
            response.taskId !== active.task.taskId ||
            !validOutcome(active.task, response)
          ) {
            crash(slot, 'Worker returned an invalid protocol message.');
            return;
          }
          const completed = finishActive(slot)!;
          complete(response);
          if (this.firstTaskMs === 0)
            this.firstTaskMs = performance.now() - startedAt;
          const shouldRecycle =
            response.type === 'lint-result' &&
            response.parserStrategy === 'buffered' &&
            completed.task.type === 'lint' &&
            completed.task.sourceBytes >= BUFFERED_WORKER_RECYCLE_THRESHOLD &&
            pending.length > 0;
          if (shouldRecycle) recycle(slot);
          else schedule();
        };
        const error = (value: Error) => crash(slot, value.message);
        const exit = (code: number) =>
          crash(slot, `Worker exited unexpectedly (${code}).`);
        slot.listeners = { message, error, exit };
        slot.worker.on('message', message);
        slot.worker.once('error', error);
        slot.worker.once('exit', exit);
      };

      for (const slot of this.#slots) attach(slot);
      schedule();
    });
  }

  async terminate(): Promise<void> {
    this.#shuttingDown = true;
    for (const slot of this.#slots) detachSlot(slot);
    const workers = this.#slots.splice(0).map((slot) => slot.worker);
    await Promise.allSettled([...this.#starting]);
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}
