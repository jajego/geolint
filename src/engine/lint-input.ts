import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { assertJsonValue } from '../input/json-value.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { DiagnosticCollector } from './diagnostics.js';
import { compilePolicy, type CompiledPolicy } from './policy.js';
import { createExecutionRequirements } from './requirements.js';
import { scanGeoJSON } from '../scanner/scan.js';
import type { GeoLintRuntimeContext, ResolvedConfig } from '../types/config.js';
import type {
  FileLintResult,
  JsonValue,
  SkippedPolicy,
  SummaryFactName,
} from '../types/semantic.js';
import { GeoLintInputError } from './errors.js';

export interface InMemoryLintOptions extends GeoLintRuntimeContext {
  readonly filename?: string;
}

async function inputContext(options: InMemoryLintOptions): Promise<{
  readonly filePath: string;
  readonly config: ResolvedConfig;
}> {
  const config = await resolveRuntimeConfig(options);
  if (options.filename) {
    const fileConfig = resolveFileConfig(config, options.filename);
    return {
      filePath: fileConfig.filePath,
      config: fileConfig,
    };
  }
  return { filePath: '<memory>', config };
}

function fileResult(
  collector: DiagnosticCollector,
  startedAt: number,
  summary?: FileLintResult['summary'],
  skippedPolicies: readonly SkippedPolicy[] = [],
): FileLintResult {
  return {
    filePath: collector.filePath,
    diagnostics: collector.diagnostics,
    suppressedDiagnostics: collector.suppressedDiagnostics,
    skippedPolicies,
    ...(summary ? { summary } : {}),
    errorCount: collector.errorCount,
    warningCount: collector.warningCount,
    durationMs: performance.now() - startedAt,
  };
}

function scanResult(
  value: JsonValue,
  collector: DiagnosticCollector,
  policy: CompiledPolicy,
  startedAt: number,
  sourceBytes?: number,
): FileLintResult {
  const facts = new Set<SummaryFactName>([
    'featureCount',
    'vertexCount',
    ...policy.facts,
  ]);
  const summary = scanGeoJSON(value, {
    filePath: collector.filePath,
    diagnostics: collector,
    ...(policy.listener ? { listener: policy.listener } : {}),
    ...(policy.coordinateObservation
      ? { coordinateObservation: policy.coordinateObservation }
      : {}),
    ...(policy.featureIdObservation
      ? { featureIdObservation: policy.featureIdObservation }
      : {}),
    requirements: createExecutionRequirements({
      facts: [...facts],
      ...(policy.listener ? { listener: policy.listener } : {}),
      exactFileBytes: policy.exactFileBytes || sourceBytes !== undefined,
    }),
    ...(sourceBytes === undefined ? {} : { sourceBytes }),
  });
  return fileResult(collector, startedAt, summary, policy.finish(summary));
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
    context.config.diagnostics,
  );
  const policy = compilePolicy(
    context.config,
    context.filePath,
    'text',
    collector,
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
    policy,
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
  const collector = new DiagnosticCollector(
    context.filePath,
    context.config.diagnostics,
  );
  const policy = compilePolicy(
    context.config,
    context.filePath,
    'object',
    collector,
  );
  assertJsonValue(value);
  return scanResult(value, collector, policy, startedAt);
}
