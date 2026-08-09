import { parentPort } from 'node:worker_threads';

import { lintResolvedFile } from '../engine/lint-input.js';
import type {
  PrototypeWorkerMessage,
  PrototypeWorkerTask,
} from './worker-prototype.js';

const port = parentPort;
if (!port) throw new Error('Worker prototype requires a parent port.');

port.postMessage({
  protocolVersion: 1,
  type: 'ready',
} satisfies PrototypeWorkerMessage);

port.on(
  'message',
  async (message: {
    readonly type: 'task';
    readonly task: PrototypeWorkerTask;
  }) => {
    const task = message.task;
    try {
      if (task.protocolVersion !== 1)
        throw new Error('Invalid worker protocol.');
      const result = await lintResolvedFile(task.absolutePath, {
        filePath: task.filePath,
        config: task.config,
        parser: task.parser,
        ...(task.baseline ? { baseline: task.baseline } : {}),
      });
      port.postMessage({
        protocolVersion: 1,
        type: 'result',
        taskId: task.taskId,
        result,
      } satisfies PrototypeWorkerMessage);
    } catch (error) {
      port.postMessage({
        protocolVersion: 1,
        type: 'error',
        taskId: task.taskId,
        message: error instanceof Error ? error.message : String(error),
      } satisfies PrototypeWorkerMessage);
    }
  },
);
