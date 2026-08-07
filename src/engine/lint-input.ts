import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { assertJsonValue } from '../input/json-value.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { createExecutionRequirements } from './requirements.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { GeoLintRuntimeContext, ResolvedConfig } from '../types/config.js';
import type {
  Diagnostic,
  FileLintResult,
  JsonValue,
} from '../types/semantic.js';
import {
  GeoLintConfigError,
  GeoLintInputError,
  GeoLintInternalError,
} from './errors.js';

export interface InMemoryLintOptions extends GeoLintRuntimeContext {
  readonly filename?: string;
}

async function filePath(options: InMemoryLintOptions): Promise<string> {
  const config = await resolveRuntimeConfig(options);
  if (options.filename) {
    const fileConfig = resolveFileConfig(config, options.filename);
    assertPhase2PolicyFree(fileConfig);
    return fileConfig.filePath;
  }
  assertPhase2PolicyFree(config);
  return '<memory>';
}

function assertPhase2PolicyFree(config: ResolvedConfig): void {
  const activeRule = Object.entries(config.rules).find(
    ([, setting]) => setting !== 'off',
  );
  if (
    activeRule ||
    Object.keys(config.budgets).length > 0 ||
    Object.keys(config.regression).length > 0 ||
    Object.keys(config.plugins).length > 0
  ) {
    throw new GeoLintConfigError(
      'Phase 2 buffered APIs do not execute configured policies yet.',
      'GEOLINT_UNIMPLEMENTED_POLICY',
    );
  }
}

function failedResult(
  path: string,
  diagnostic: Diagnostic,
  startedAt: number,
): FileLintResult {
  return {
    filePath: path,
    diagnostics: [diagnostic],
    suppressedDiagnostics: [],
    skippedPolicies: [],
    errorCount: 1,
    warningCount: 0,
    durationMs: performance.now() - startedAt,
  };
}

function scanResult(
  value: JsonValue,
  path: string,
  startedAt: number,
  sourceBytes?: number,
): FileLintResult {
  try {
    const summary = scanGeoJSON(value, {
      filePath: path,
      requirements: createExecutionRequirements({
        facts: ['featureCount', 'vertexCount'],
        exactFileBytes: sourceBytes !== undefined,
      }),
      ...(sourceBytes === undefined ? {} : { sourceBytes }),
    });
    return {
      filePath: path,
      diagnostics: [],
      suppressedDiagnostics: [],
      skippedPolicies: [],
      summary,
      errorCount: 0,
      warningCount: 0,
      durationMs: performance.now() - startedAt,
    };
  } catch (error) {
    if (
      error instanceof GeoLintInternalError &&
      error.code === 'GEOLINT_INVALID_SEMANTIC_INPUT'
    ) {
      return failedResult(
        path,
        {
          code: error.message.startsWith('Expected a supported GeoJSON root')
            ? 'geojson/invalid-root'
            : 'geojson/invalid-structure',
          severity: 'error',
          message: error.message,
        },
        startedAt,
      );
    }
    throw error;
  }
}

export async function lintGeoJSONText(
  text: string,
  options: InMemoryLintOptions = {},
): Promise<FileLintResult> {
  if (typeof text !== 'string') {
    throw new GeoLintInputError(
      'lintGeoJSONText() requires a string.',
      'GEOLINT_INVALID_JSON_TEXT',
    );
  }
  const startedAt = performance.now();
  const path = await filePath(options);
  const parsed = parseBufferedJSON(text);
  if (!parsed.ok) {
    return failedResult(
      path,
      {
        code: 'parse/invalid-json',
        severity: 'error',
        message: 'Input is not valid JSON.',
      },
      startedAt,
    );
  }
  return scanResult(
    parsed.value,
    path,
    startedAt,
    Buffer.byteLength(text, 'utf8'),
  );
}

export async function lintGeoJSON(
  value: unknown,
  options: InMemoryLintOptions = {},
): Promise<FileLintResult> {
  const startedAt = performance.now();
  const path = await filePath(options);
  assertJsonValue(value);
  return scanResult(value, path, startedAt);
}
