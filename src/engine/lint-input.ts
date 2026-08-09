import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { assertJsonValue } from '../input/json-value.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import {
  IndexedSyntaxError,
  parseIndexedSource,
} from '../parser/indexed-source.js';
import { DiagnosticCollector } from './diagnostics.js';
import { compilePolicy, type CompiledPolicy } from './policy.js';
import { createExecutionRequirements } from './requirements.js';
import { scanGeoJSON } from '../scanner/scan.js';
import {
  loadBaseline,
  regressionIdentity,
  resolveBaselinePath,
} from '../regression/baseline-io.js';
import { hasEnabledRegression } from '../regression/compare.js';
import type { BaselineFileEntry } from '../regression/schema.js';
import type { GeoLintRuntimeContext, ResolvedConfig } from '../types/config.js';
import type {
  FileLintResult,
  JsonValue,
  SkippedPolicy,
  SummaryFactName,
} from '../types/semantic.js';
import {
  GeoLintCapabilityError,
  GeoLintIOError,
  GeoLintInputError,
} from './errors.js';
import type { ExecutionRequirements } from './requirements.js';

export type ParserStrategy = 'auto' | 'buffered' | 'indexed';

export interface InMemoryLintOptions extends GeoLintRuntimeContext {
  readonly filename?: string;
  readonly parser?: ParserStrategy;
}

export interface FileLintOptions extends GeoLintRuntimeContext {
  readonly parser?: ParserStrategy;
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

function requirementsFor(
  policy: CompiledPolicy,
  sourceBytesAvailable: boolean,
): ExecutionRequirements {
  const facts = new Set<SummaryFactName>([
    'featureCount',
    'vertexCount',
    ...policy.facts,
  ]);
  return createExecutionRequirements({
    facts: [...facts],
    ...(policy.listener ? { listener: policy.listener } : {}),
    exactFileBytes: policy.exactFileBytes || sourceBytesAvailable,
    numericLexemes: policy.numericLexemes,
    featureByteSpans: policy.featureByteSpans,
  });
}

function scanResult(
  value: JsonValue,
  collector: DiagnosticCollector,
  policy: CompiledPolicy,
  startedAt: number,
  requirements: ExecutionRequirements,
  sourceBytes?: number,
): FileLintResult {
  const summary = scanGeoJSON(value, {
    filePath: collector.filePath,
    diagnostics: collector,
    ...(policy.listener ? { listener: policy.listener } : {}),
    ...(policy.coordinateObservation
      ? { coordinateObservation: policy.coordinateObservation }
      : {}),
    ...(policy.coordinateLexemeObservation
      ? { coordinateLexemeObservation: policy.coordinateLexemeObservation }
      : {}),
    ...(policy.featureIdObservation
      ? { featureIdObservation: policy.featureIdObservation }
      : {}),
    ...(policy.featureByteObservation
      ? { featureByteObservation: policy.featureByteObservation }
      : {}),
    requirements,
    ...(sourceBytes === undefined ? {} : { sourceBytes }),
  });
  return fileResult(collector, startedAt, summary, policy.finish(summary));
}

async function regressionBaseline(
  config: ResolvedConfig,
  filePath: string,
): Promise<BaselineFileEntry | undefined> {
  if (!hasEnabledRegression(config.regression)) return undefined;
  const identity = regressionIdentity(filePath);
  const baseline = await loadBaseline(resolveBaselinePath(config));
  return baseline.files[identity];
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
  const baseline = await regressionBaseline(context.config, context.filePath);
  const policy = compilePolicy(
    context.config,
    context.filePath,
    'text',
    collector,
    baseline,
  );
  const requirements = requirementsFor(policy, true);
  const parser = options.parser ?? 'auto';
  if (
    parser === 'buffered' &&
    (requirements.numericLexemes || requirements.featureByteSpans)
  ) {
    throw new GeoLintCapabilityError(
      `The buffered parser cannot satisfy ${requirements.numericLexemes ? 'numeric-lexeme' : 'Feature-span'} requirements. Use parser "auto" or "indexed".`,
      requirements.numericLexemes
        ? 'GEOLINT_CAPABILITY_NUMERIC_LEXEMES'
        : 'GEOLINT_CAPABILITY_FEATURE_BYTES',
    );
  }
  const strategy =
    parser === 'indexed' ||
    (parser === 'auto' &&
      (requirements.numericLexemes || requirements.featureByteSpans))
      ? 'indexed'
      : 'buffered';
  if (strategy === 'buffered') {
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
      requirements,
      Buffer.byteLength(text, 'utf8'),
    );
  }
  try {
    const parsed = parseIndexedSource(text, requirements);
    return scanResult(
      parsed.value,
      collector,
      policy,
      startedAt,
      requirements,
      parsed.sourceBytes,
    );
  } catch (error) {
    if (!(error instanceof IndexedSyntaxError)) throw error;
    collector.report({
      code: 'parse/invalid-json',
      source: 'parser',
      message: 'Input is not valid JSON.',
      byteOffset: error.byteOffset,
    });
    return fileResult(collector, startedAt);
  }
}

export async function lintGeoJSON(
  value: unknown,
  options: InMemoryLintOptions = {},
): Promise<FileLintResult> {
  if (options.parser === 'indexed') {
    throw new GeoLintCapabilityError(
      'Parser "indexed" requires source text and is unavailable for lintGeoJSON(value).',
      'GEOLINT_CAPABILITY_INDEXED_SOURCE',
    );
  }
  const startedAt = performance.now();
  const context = await inputContext(options);
  const collector = new DiagnosticCollector(
    context.filePath,
    context.config.diagnostics,
  );
  const baseline = await regressionBaseline(context.config, context.filePath);
  const policy = compilePolicy(
    context.config,
    context.filePath,
    'object',
    collector,
    baseline,
  );
  assertJsonValue(value);
  return scanResult(
    value,
    collector,
    policy,
    startedAt,
    requirementsFor(policy, false),
  );
}

export async function lintFile(
  path: string,
  options: FileLintOptions = {},
): Promise<FileLintResult> {
  const absolutePath = resolve(options.cwd ?? process.cwd(), path);
  let bytes: Buffer;
  try {
    bytes = await readFile(absolutePath);
  } catch (cause) {
    throw new GeoLintIOError(
      `Could not read GeoJSON file at ${absolutePath}.`,
      'GEOLINT_FILE_READ_FAILED',
      { cause },
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const startedAt = performance.now();
    const context = await inputContext({ ...options, filename: absolutePath });
    const collector = new DiagnosticCollector(
      context.filePath,
      context.config.diagnostics,
    );
    collector.report({
      code: 'parse/invalid-encoding',
      source: 'parser',
      message: 'Input is not valid UTF-8.',
    });
    return fileResult(collector, startedAt);
  }
  return lintGeoJSONText(text, { ...options, filename: absolutePath });
}
