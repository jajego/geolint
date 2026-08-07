import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { assertJsonValue } from '../input/json-value.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { DiagnosticCollector } from './diagnostics.js';
import { createExecutionRequirements } from './requirements.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { GeoLintRuntimeContext, ResolvedConfig } from '../types/config.js';
import type { FileLintResult, JsonValue } from '../types/semantic.js';
import { GeoLintConfigError, GeoLintInputError } from './errors.js';

export interface InMemoryLintOptions extends GeoLintRuntimeContext {
  readonly filename?: string;
}

async function inputContext(options: InMemoryLintOptions): Promise<{
  readonly filePath: string;
  readonly diagnostics: ResolvedConfig['diagnostics'];
}> {
  const config = await resolveRuntimeConfig(options);
  if (options.filename) {
    const fileConfig = resolveFileConfig(config, options.filename);
    assertPolicyFree(fileConfig);
    return {
      filePath: fileConfig.filePath,
      diagnostics: fileConfig.diagnostics,
    };
  }
  assertPolicyFree(config);
  return { filePath: '<memory>', diagnostics: config.diagnostics };
}

function assertPolicyFree(config: ResolvedConfig): void {
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
      'Buffered APIs do not execute configured policies yet.',
      'GEOLINT_UNIMPLEMENTED_POLICY',
    );
  }
}

function fileResult(
  collector: DiagnosticCollector,
  startedAt: number,
  summary?: FileLintResult['summary'],
): FileLintResult {
  return {
    filePath: collector.filePath,
    diagnostics: collector.diagnostics,
    suppressedDiagnostics: collector.suppressedDiagnostics,
    skippedPolicies: [],
    ...(summary ? { summary } : {}),
    errorCount: collector.errorCount,
    warningCount: collector.warningCount,
    durationMs: performance.now() - startedAt,
  };
}

function scanResult(
  value: JsonValue,
  collector: DiagnosticCollector,
  startedAt: number,
  sourceBytes?: number,
): FileLintResult {
  const summary = scanGeoJSON(value, {
    filePath: collector.filePath,
    diagnostics: collector,
    requirements: createExecutionRequirements({
      facts: ['featureCount', 'vertexCount'],
      exactFileBytes: sourceBytes !== undefined,
    }),
    ...(sourceBytes === undefined ? {} : { sourceBytes }),
  });
  return fileResult(collector, startedAt, summary);
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
  const context = await inputContext(options);
  const collector = new DiagnosticCollector(
    context.filePath,
    context.diagnostics,
  );
  const parsed = parseBufferedJSON(text);
  if (!parsed.ok) {
    collector.report({
      code: 'parse/invalid-json',
      source: 'parser',
      message: 'Input is not valid JSON.',
    });
    return fileResult(collector, startedAt);
  }
  return scanResult(
    parsed.value,
    collector,
    startedAt,
    Buffer.byteLength(text, 'utf8'),
  );
}

export async function lintGeoJSON(
  value: unknown,
  options: InMemoryLintOptions = {},
): Promise<FileLintResult> {
  const startedAt = performance.now();
  const context = await inputContext(options);
  assertJsonValue(value);
  return scanResult(
    value,
    new DiagnosticCollector(context.filePath, context.diagnostics),
    startedAt,
  );
}
