import { parentPort } from 'node:worker_threads';

import {
  stabilizePlugin,
  validatePlugin,
  type GeoLintPlugin,
} from '../plugins/plugin.js';
import { lintResolvedFile } from '../engine/lint-input.js';
import { captureSnapshotFile } from '../regression/snapshot.js';
import { GeoLintError, GeoLintPluginError } from '../engine/errors.js';
import type {
  WorkerErrorEnvelope,
  WorkerLintTask,
  WorkerPluginReference,
  WorkerResponse,
  WorkerTask,
} from './protocol.js';

const port = parentPort;
if (!port) throw new Error('GeoLint worker requires a parent port.');

const pluginCache = new Map<string, Promise<GeoLintPlugin>>();

function loadPlugin(reference: WorkerPluginReference): Promise<GeoLintPlugin> {
  const key = `${reference.moduleUrl}\0${reference.exportName}`;
  let pending = pluginCache.get(key);
  if (!pending) {
    pending = (async () => {
      const module = (await import(reference.moduleUrl)) as Record<
        string,
        unknown
      >;
      const plugin = module[reference.exportName];
      validatePlugin(plugin, `plugin ${JSON.stringify(reference.namespace)}`);
      if (
        plugin.meta.apiVersion !== reference.apiVersion ||
        plugin.meta.moduleUrl !== reference.moduleUrl ||
        plugin.meta.exportName !== reference.exportName
      )
        throw new Error(
          `Reloaded plugin ${JSON.stringify(reference.namespace)} does not match its declared identity.`,
        );
      return stabilizePlugin(plugin);
    })();
    pluginCache.set(key, pending);
  }
  return pending;
}

async function lint(task: WorkerLintTask) {
  const plugins = Object.fromEntries(
    await Promise.all(
      task.plugins.map(async (reference) => [
        reference.namespace,
        await loadPlugin(reference),
      ]),
    ),
  );
  return lintResolvedFile(task.absolutePath, {
    filePath: task.filePath,
    config: { ...task.policy, plugins },
    parser: task.parser,
    ...(task.baseline ? { baseline: task.baseline } : {}),
  });
}

function envelope(error: unknown, task: WorkerTask): WorkerErrorEnvelope {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: value.name,
    code: error instanceof GeoLintError ? error.code : 'GEOLINT_INTERNAL_ERROR',
    message: value.message,
    filePath:
      error instanceof GeoLintPluginError ? error.filePath : task.filePath,
    ...(error instanceof GeoLintPluginError ? { ruleId: error.ruleId } : {}),
    ...(value.stack ? { stack: value.stack } : {}),
    ...(value.cause === undefined ? {} : { cause: String(value.cause) }),
  };
}

port.postMessage({
  protocolVersion: 1,
  type: 'ready',
} satisfies WorkerResponse);
port.on('message', async (task: WorkerTask) => {
  try {
    if (task.protocolVersion !== 1) throw new Error('Invalid worker protocol.');
    if (task.type === 'lint') {
      port.postMessage({
        protocolVersion: 1,
        type: 'lint-result',
        taskId: task.taskId,
        result: await lint(task),
      } satisfies WorkerResponse);
    } else if (task.type === 'snapshot') {
      port.postMessage({
        protocolVersion: 1,
        type: 'snapshot-result',
        taskId: task.taskId,
        result: await captureSnapshotFile(task.absolutePath, task.filePath),
      } satisfies WorkerResponse);
    } else {
      throw new Error('Invalid worker task type.');
    }
  } catch (error) {
    port.postMessage({
      protocolVersion: 1,
      type: 'error',
      taskId: task.taskId,
      error: envelope(error, task),
    } satisfies WorkerResponse);
  }
});
