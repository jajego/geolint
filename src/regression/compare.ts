import { parseByteSize } from '../engine/byte-size.js';
import { DiagnosticCollector } from '../engine/diagnostics.js';
import { GeoLintCapabilityError } from '../engine/errors.js';
import { skipPolicyForIncompleteFacts } from '../engine/requirements.js';
import type { RegressionConfig, RegressionSeverity } from '../types/config.js';
import type {
  FileSummary,
  JsonValueType,
  SkippedPolicy,
  SummaryFactName,
} from '../types/semantic.js';
import {
  geometryTypeOrder,
  propertyTypeOrder,
  type BaselineFileEntry,
} from './schema.js';

type Severity = 'warning' | 'error';
type InputKind = 'object' | 'text';

interface RegressionPolicy {
  readonly code: string;
  readonly severity: Severity;
  readonly requires: readonly SummaryFactName[];
  evaluate(summary: FileSummary, baseline: BaselineFileEntry): void;
}

export interface CompiledRegression {
  readonly facts: readonly SummaryFactName[];
  readonly exactFileBytes: boolean;
  finish(summary: FileSummary): readonly SkippedPolicy[];
}

function severity(value: Exclude<RegressionSeverity, 'off'>): Severity {
  return value === 'warn' ? 'warning' : 'error';
}

function enabled(value: RegressionSeverity | undefined): Severity | undefined {
  return value && value !== 'off' ? severity(value) : undefined;
}

export function hasEnabledRegression(config: RegressionConfig): boolean {
  if (Object.keys(config.thresholds ?? {}).length > 0) return true;
  return Object.values(config.checks ?? {}).some((group) =>
    Object.values(group ?? {}).some((value) => value !== 'off'),
  );
}

function report(
  diagnostics: DiagnosticCollector,
  code: string,
  configuredSeverity: Severity,
  message: string,
  data: Readonly<Record<string, unknown>>,
): void {
  diagnostics.reportLazy(
    { code, source: 'regression', severity: configuredSeverity },
    () => ({ message, data }),
  );
}

function changeData(baseline: number, current: number) {
  const delta = current - baseline;
  return {
    baseline,
    current,
    delta,
    ...(baseline === 0
      ? { percentageUnbounded: current > 0 }
      : { percentage: (delta / baseline) * 100 }),
  };
}

function increaseExceeded(
  baseline: number,
  current: number,
  percentage: number | undefined,
  minimum: number | undefined,
): boolean {
  const delta = current - baseline;
  if (delta <= 0) return false;
  const percentageExceeded =
    percentage === undefined ||
    baseline === 0 ||
    (delta / baseline) * 100 > percentage;
  const minimumExceeded = minimum === undefined || delta > minimum;
  return percentageExceeded && minimumExceeded;
}

function addNumericPolicies(
  policies: RegressionPolicy[],
  config: RegressionConfig,
  diagnostics: DiagnosticCollector,
): boolean {
  const fileSize = config.thresholds?.fileSizeIncrease;
  if (fileSize) {
    const minimum =
      fileSize.minimumIncrease === undefined
        ? undefined
        : parseByteSize(
            fileSize.minimumIncrease,
            'regression.thresholds.fileSizeIncrease.minimumIncrease',
          );
    policies.push({
      code: 'regression/file-size',
      severity: 'error',
      requires: [],
      evaluate(summary, baseline) {
        const current = summary.bytes!;
        if (
          increaseExceeded(
            baseline.bytes,
            current,
            fileSize.percentage,
            minimum,
          )
        ) {
          report(
            diagnostics,
            'regression/file-size',
            'error',
            'File size increased beyond its approved threshold.',
            changeData(baseline.bytes, current),
          );
        }
      },
    });
  }
  const vertices = config.thresholds?.totalVerticesIncrease;
  if (vertices) {
    policies.push({
      code: 'regression/vertex-count',
      severity: 'error',
      requires: ['vertexCount'],
      evaluate(summary, baseline) {
        if (
          increaseExceeded(
            baseline.totalVertices,
            summary.totalVertices,
            vertices.percentage,
            vertices.minimumIncrease,
          )
        ) {
          report(
            diagnostics,
            'regression/vertex-count',
            'error',
            'Vertex count increased beyond its approved threshold.',
            changeData(baseline.totalVertices, summary.totalVertices),
          );
        }
      },
    });
  }
  const features = config.thresholds?.featureCountDecrease;
  if (features) {
    policies.push({
      code: 'regression/feature-count',
      severity: 'error',
      requires: ['featureCount'],
      evaluate(summary, baseline) {
        const decrease = baseline.featureCount - summary.featureCount;
        const percentageExceeded =
          features.percentage === undefined ||
          (baseline.featureCount > 0 &&
            (decrease / baseline.featureCount) * 100 > features.percentage);
        const minimumExceeded =
          features.minimumDecrease === undefined ||
          decrease > features.minimumDecrease;
        if (decrease > 0 && percentageExceeded && minimumExceeded) {
          report(
            diagnostics,
            'regression/feature-count',
            'error',
            'Feature count decreased beyond its approved threshold.',
            {
              baseline: baseline.featureCount,
              current: summary.featureCount,
              delta: -decrease,
              percentage: (decrease / baseline.featureCount) * 100,
            },
          );
        }
      },
    });
  }
  return Boolean(fileSize);
}

function currentPropertyTypes(
  summary: FileSummary,
  key: string,
): readonly JsonValueType[] {
  const types = summary.propertyStats!.get(key)!.types;
  return propertyTypeOrder.filter((type) => (types.get(type) ?? 0) > 0);
}

function relation(
  baseline: ReadonlySet<JsonValueType>,
  current: ReadonlySet<JsonValueType>,
): 'same' | 'widened' | 'narrowed' | 'changed' {
  const baselineSubset = [...baseline].every((type) => current.has(type));
  const currentSubset = [...current].every((type) => baseline.has(type));
  if (baselineSubset && currentSubset) return 'same';
  if (baselineSubset) return 'widened';
  if (currentSubset) return 'narrowed';
  return 'changed';
}

function addPropertyPolicies(
  policies: RegressionPolicy[],
  config: RegressionConfig,
  diagnostics: DiagnosticCollector,
): void {
  const types = config.checks?.propertyTypes;
  for (const direction of ['widened', 'narrowed', 'changed'] as const) {
    const configured = enabled(types?.[direction]);
    if (!configured) continue;
    const code = `regression/property-types-${direction}`;
    policies.push({
      code,
      severity: configured,
      requires: ['propertyStats'],
      evaluate(summary, baseline) {
        const common = Object.keys(baseline.properties)
          .filter((key) => summary.propertyStats!.has(key))
          .sort();
        for (const property of common) {
          const baselineTypes = propertyTypeOrder.filter(
            (type) => baseline.properties[property]!.types[type] !== undefined,
          );
          const currentTypes = currentPropertyTypes(summary, property);
          if (
            relation(new Set(baselineTypes), new Set(currentTypes)) ===
            direction
          ) {
            report(
              diagnostics,
              code,
              configured,
              `Property "${property}" types ${direction}.`,
              { property, baselineTypes, currentTypes },
            );
          }
        }
      },
    });
  }

  const properties = config.checks?.properties;
  for (const direction of ['added', 'removed'] as const) {
    const configured = enabled(properties?.[direction]);
    if (!configured) continue;
    const code = `regression/property-${direction}`;
    policies.push({
      code,
      severity: configured,
      requires: ['propertyStats'],
      evaluate(summary, baseline) {
        const baselineKeys = new Set(Object.keys(baseline.properties));
        const currentKeys = new Set(summary.propertyStats!.keys());
        const keys =
          direction === 'added'
            ? [...currentKeys].filter((key) => !baselineKeys.has(key))
            : [...baselineKeys].filter((key) => !currentKeys.has(key));
        for (const property of keys.sort()) {
          report(
            diagnostics,
            code,
            configured,
            `Property "${property}" was ${direction}.`,
            { property },
          );
        }
      },
    });
  }
}

function addGeometryPolicies(
  policies: RegressionPolicy[],
  config: RegressionConfig,
  diagnostics: DiagnosticCollector,
): void {
  const geometry = config.checks?.geometryTypes;
  for (const direction of ['added', 'removed'] as const) {
    const configured = enabled(geometry?.[direction]);
    if (!configured) continue;
    const code = `regression/geometry-type-${direction}`;
    policies.push({
      code,
      severity: configured,
      requires: ['geometryStats'],
      evaluate(summary, baseline) {
        const baselineTypes = new Set(
          Object.keys(baseline.featureGeometryTypes),
        );
        const currentTypes = new Set(
          [...summary.featureGeometryTypes!.keys()].filter(
            (type) => type !== 'null',
          ),
        );
        const types = geometryTypeOrder.filter((type) =>
          direction === 'added'
            ? currentTypes.has(type) && !baselineTypes.has(type)
            : baselineTypes.has(type) && !currentTypes.has(type),
        );
        for (const geometryType of types) {
          report(
            diagnostics,
            code,
            configured,
            `Geometry type "${geometryType}" was ${direction}.`,
            { geometryType },
          );
        }
      },
    });
  }
}

function addCountPolicy(
  policies: RegressionPolicy[],
  diagnostics: DiagnosticCollector,
  options: {
    readonly code: string;
    readonly severity: RegressionSeverity | undefined;
    readonly fact: 'idStats' | 'geometryStats';
    readonly baseline: (entry: BaselineFileEntry) => number;
    readonly current: (summary: FileSummary) => number;
    readonly label: string;
  },
): void {
  const configured = enabled(options.severity);
  if (!configured) return;
  policies.push({
    code: options.code,
    severity: configured,
    requires: [options.fact],
    evaluate(summary, baseline) {
      const oldValue = options.baseline(baseline);
      const newValue = options.current(summary);
      if (newValue > oldValue) {
        report(
          diagnostics,
          options.code,
          configured,
          `${options.label} increased from the approved baseline.`,
          { baseline: oldValue, current: newValue },
        );
      }
    },
  });
}

export function compileRegression(
  config: RegressionConfig,
  inputKind: InputKind,
  diagnostics: DiagnosticCollector,
  baseline: BaselineFileEntry | undefined,
): CompiledRegression {
  const policies: RegressionPolicy[] = [];
  const exactFileBytes = addNumericPolicies(policies, config, diagnostics);
  if (exactFileBytes && inputKind === 'object') {
    throw new GeoLintCapabilityError(
      'File-size regression requires exact source bytes, which parsed object input cannot provide.',
      'GEOLINT_CAPABILITY_FILE_BYTES',
    );
  }
  addPropertyPolicies(policies, config, diagnostics);
  addGeometryPolicies(policies, config, diagnostics);
  addCountPolicy(policies, diagnostics, {
    code: 'regression/duplicate-ids-increased',
    severity: config.checks?.duplicateIds?.increased,
    fact: 'idStats',
    baseline: (entry) => entry.ids.duplicates,
    current: (summary) => summary.ids!.duplicateCount,
    label: 'Duplicate ID count',
  });
  addCountPolicy(policies, diagnostics, {
    code: 'regression/missing-ids-increased',
    severity: config.checks?.missingIds?.increased,
    fact: 'idStats',
    baseline: (entry) => entry.ids.missing,
    current: (summary) => summary.ids!.missing,
    label: 'Missing ID count',
  });
  addCountPolicy(policies, diagnostics, {
    code: 'regression/null-geometries-increased',
    severity: config.checks?.nullGeometries?.increased,
    fact: 'geometryStats',
    baseline: (entry) => entry.nullGeometries,
    current: (summary) => summary.nullGeometryCount!,
    label: 'Null geometry count',
  });
  const facts = [...new Set(policies.flatMap((policy) => policy.requires))];
  return {
    facts,
    exactFileBytes,
    finish(summary) {
      if (!baseline) {
        return policies.map((policy) => ({
          code: policy.code,
          source: 'regression' as const,
          reason: 'no-baseline' as const,
          configuredSeverity: policy.severity,
        }));
      }
      const skipped: SkippedPolicy[] = [];
      for (const policy of policies) {
        const skip = skipPolicyForIncompleteFacts({
          code: policy.code,
          source: 'regression',
          requiredFacts: policy.requires,
          completeness: summary.completeness,
          configuredSeverity: policy.severity,
        });
        if (skip) skipped.push(skip);
        else policy.evaluate(summary, baseline);
      }
      return skipped;
    },
  };
}
