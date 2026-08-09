import type { BaselineFileEntry } from '../regression/schema.js';
import type { ResolvedConfig } from '../types/config.js';
import type { FileLintResult } from '../types/semantic.js';
import type { ParserStrategy } from '../engine/lint-input.js';

export interface WorkerPluginReference {
  readonly namespace: string;
  readonly moduleUrl: string;
  readonly exportName: string;
  readonly apiVersion: 1;
}

export type SerializedResolvedPolicy = Omit<ResolvedConfig, 'plugins'>;

interface WorkerTaskBase {
  readonly protocolVersion: 1;
  readonly taskId: number;
  readonly absolutePath: string;
  readonly filePath: string;
}

export interface WorkerLintTask extends WorkerTaskBase {
  readonly type: 'lint';
  readonly policy: SerializedResolvedPolicy;
  readonly plugins: readonly WorkerPluginReference[];
  readonly baseline?: BaselineFileEntry;
  readonly parser: ParserStrategy;
}

export interface WorkerSnapshotTask extends WorkerTaskBase {
  readonly type: 'snapshot';
}

export type WorkerTask = WorkerLintTask | WorkerSnapshotTask;

export interface WorkerErrorEnvelope {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly filePath?: string;
  readonly ruleId?: string;
  readonly stack?: string;
  readonly cause?: string;
}

export type WorkerResponse =
  | { readonly protocolVersion: 1; readonly type: 'ready' }
  | {
      readonly protocolVersion: 1;
      readonly type: 'lint-result';
      readonly taskId: number;
      readonly result: FileLintResult;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: 'snapshot-result';
      readonly taskId: number;
      readonly result: BaselineFileEntry;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: 'error';
      readonly taskId: number;
      readonly error: WorkerErrorEnvelope;
    };

export type WorkerTaskOutcome = Exclude<WorkerResponse, { type: 'ready' }>;
