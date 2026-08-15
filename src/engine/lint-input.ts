import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { assertJsonValue } from '../input/json-value.js';
import { decodeSource } from '../input/decode-source.js';
import { parseBufferedJSON } from '../parser/buffered-json.js';
import { scanDuplicateKeysFromValidJSON } from '../parser/duplicate-keys.js';
import {
  type DuplicateJsonKey,
  JsonSourceSyntaxError,
} from '../parser/json-source.js';
import { formatQuotedValue } from '../terminal-text.js';
import { parseIndexedSource } from '../parser/indexed-source.js';
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

export interface ResolvedSourceOptions {
  readonly filePath: string;
  readonly config: ResolvedConfig;
  readonly parser: ParserStrategy;
  readonly baseline?: BaselineFileEntry;
}

export interface InMemoryLintOptions extends GeoLintRuntimeContext {
  readonly filename?: string;
}

export type FileLintOptions = GeoLintRuntimeContext;

interface InternalParserOptions {
  readonly parser: ParserStrategy;
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

function reportDuplicateKeys(
  collector: DiagnosticCollector,
  duplicates: readonly DuplicateJsonKey[],
): void {
  for (const { key, path, byteOffset } of duplicates) {
    collector.report({
      code: 'json/duplicate-key',
      source: 'parser',
      message: `Duplicate JSON object key ${formatQuotedValue(key)}; later value overrides an earlier value.`,
      path,
      byteOffset,
      data: { key },
    });
  }
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

function lintResolvedText(
  text: string,
  options: ResolvedSourceOptions,
): FileLintResult {
  if (typeof text !== 'string') {
    throw new GeoLintInputError(
      'lintGeoJSONText() requires a string.',
      'GEOLINT_INVALID_JSON_TEXT',
    );
  }
  const startedAt = performance.now();
  const collector = new DiagnosticCollector(
    options.filePath,
    options.config.diagnostics,
  );
  const policy = compilePolicy(
    options.config,
    options.filePath,
    'text',
    collector,
    options.baseline,
  );
  const requirements = requirementsFor(policy, true);
  if (
    options.parser === 'buffered' &&
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
    options.parser === 'indexed' ||
    (options.parser === 'auto' &&
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
    reportDuplicateKeys(collector, scanDuplicateKeysFromValidJSON(text));
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
    reportDuplicateKeys(collector, parsed.duplicateKeys);
    return scanResult(
      parsed.value,
      collector,
      policy,
      startedAt,
      requirements,
      parsed.sourceBytes,
    );
  } catch (error) {
    if (!(error instanceof JsonSourceSyntaxError)) throw error;
    collector.report({
      code: 'parse/invalid-json',
      source: 'parser',
      message: 'Input is not valid JSON.',
      byteOffset: error.byteOffset,
    });
    return fileResult(collector, startedAt);
  }
}

async function lintGeoJSONTextUsingParser(
  text: string,
  options: InMemoryLintOptions,
  parser: ParserStrategy,
): Promise<FileLintResult> {
  const context = await inputContext(options);
  const baseline = await regressionBaseline(context.config, context.filePath);
  return lintResolvedText(text, {
    ...context,
    parser,
    ...(baseline ? { baseline } : {}),
  });
}

export function lintGeoJSONText(
  text: string,
  options: InMemoryLintOptions = {},
): Promise<FileLintResult> {
  return lintGeoJSONTextUsingParser(text, options, 'auto');
}

export function lintGeoJSONTextWithParser(
  text: string,
  options: InMemoryLintOptions & InternalParserOptions,
): Promise<FileLintResult> {
  return lintGeoJSONTextUsingParser(text, options, options.parser);
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

async function lintFileUsingParser(
  path: string,
  options: FileLintOptions,
  parser: ParserStrategy,
): Promise<FileLintResult> {
  const absolutePath = resolve(options.cwd ?? process.cwd(), path);
  const context = await inputContext({ ...options, filename: absolutePath });
  const baseline = await regressionBaseline(context.config, context.filePath);
  return lintResolvedFile(absolutePath, {
    ...context,
    parser,
    ...(baseline ? { baseline } : {}),
  });
}

export async function lintResolvedFile(
  absolutePath: string,
  options: ResolvedSourceOptions,
): Promise<FileLintResult> {
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
  return lintResolvedBytes(bytes, options);
}

export function lintResolvedBytes(
  bytes: Uint8Array,
  options: ResolvedSourceOptions,
): FileLintResult {
  let text: string;
  try {
    text = decodeSource(bytes);
  } catch {
    const startedAt = performance.now();
    const collector = new DiagnosticCollector(
      options.filePath,
      options.config.diagnostics,
    );
    collector.report({
      code: 'parse/invalid-encoding',
      source: 'parser',
      message: 'Input is not valid UTF-8.',
    });
    return fileResult(collector, startedAt);
  }
  return lintResolvedText(text, options);
}

export function lintFile(
  path: string,
  options: FileLintOptions = {},
): Promise<FileLintResult> {
  return lintFileUsingParser(path, options, 'auto');
}

export function lintFileWithParser(
  path: string,
  options: FileLintOptions & InternalParserOptions,
): Promise<FileLintResult> {
  return lintFileUsingParser(path, options, options.parser);
}
