import { parseByteSize } from '../engine/byte-size.js';
import {
  configRecord,
  invalidConfig,
  validateConfigKeys,
} from './validation.js';

const diagnosticKeys = new Set(['maxPerCodePerFile', 'maxPerFile']);
const severityValues = new Set(['off', 'warn', 'error']);
const regressionKeys = new Set(['baseline', 'checks', 'thresholds']);
const propertyTypeCheckKeys = new Set(['widened', 'narrowed', 'changed']);
const addedRemovedCheckKeys = new Set(['added', 'removed']);
const increasedCheckKeys = new Set(['increased']);
const regressionCheckKeys = new Set([
  'propertyTypes',
  'properties',
  'geometryTypes',
  'duplicateIds',
  'missingIds',
  'nullGeometries',
]);
const regressionThresholdKeys = new Set([
  'fileSizeIncrease',
  'totalVerticesIncrease',
  'featureCountDecrease',
]);

function validateRules(value: unknown, path: string): void {
  for (const [name, setting] of Object.entries(configRecord(value, path))) {
    const severity = Array.isArray(setting) ? setting[0] : setting;
    if (
      !severityValues.has(String(severity)) ||
      (Array.isArray(setting) && severity === 'off') ||
      (Array.isArray(setting) && (setting.length < 1 || setting.length > 2))
    ) {
      invalidConfig(
        `${path}.${name}`,
        'a severity or [severity, options] tuple',
      );
    }
  }
}

function validateDiagnostics(value: unknown, path: string): void {
  const diagnostics = configRecord(value, path);
  validateConfigKeys(diagnostics, diagnosticKeys, path);
  for (const [key, limit] of Object.entries(diagnostics)) {
    if (!Number.isSafeInteger(limit) || Number(limit) < 0) {
      invalidConfig(`${path}.${key}`, 'a non-negative safe integer');
    }
  }
}

function validateSeverities(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const settings = configRecord(value, path);
  validateConfigKeys(settings, allowed, path);
  for (const [key, severity] of Object.entries(settings)) {
    if (!severityValues.has(String(severity))) {
      invalidConfig(`${path}.${key}`, 'off, warn, or error');
    }
  }
}

function validatePercentage(value: unknown, path: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalidConfig(path, 'a non-negative finite number');
  }
}

function validateCount(value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    invalidConfig(path, 'a non-negative safe integer');
  }
}

function validateThreshold(
  value: unknown,
  path: string,
  absoluteKey: 'minimumIncrease' | 'minimumDecrease',
  bytes = false,
): void {
  const threshold = configRecord(value, path);
  validateConfigKeys(threshold, new Set(['percentage', absoluteKey]), path);
  if (!('percentage' in threshold) && !(absoluteKey in threshold)) {
    invalidConfig(path, `an object containing percentage or ${absoluteKey}`);
  }
  if ('percentage' in threshold) {
    validatePercentage(threshold.percentage, `${path}.percentage`);
  }
  if (absoluteKey in threshold) {
    if (bytes) {
      try {
        parseByteSize(threshold[absoluteKey], `${path}.${absoluteKey}`);
      } catch {
        invalidConfig(`${path}.${absoluteKey}`, 'a valid byte-size string');
      }
    } else {
      validateCount(threshold[absoluteKey], `${path}.${absoluteKey}`);
    }
  }
}

function validateRegression(value: unknown, path: string): void {
  const regression = configRecord(value, path);
  validateConfigKeys(regression, regressionKeys, path);
  if (
    'baseline' in regression &&
    (typeof regression.baseline !== 'string' ||
      regression.baseline.length === 0)
  ) {
    invalidConfig(`${path}.baseline`, 'a non-empty string');
  }
  if ('checks' in regression) {
    const checks = configRecord(regression.checks, `${path}.checks`);
    validateConfigKeys(checks, regressionCheckKeys, `${path}.checks`);
    if ('propertyTypes' in checks)
      validateSeverities(
        checks.propertyTypes,
        propertyTypeCheckKeys,
        `${path}.checks.propertyTypes`,
      );
    if ('properties' in checks)
      validateSeverities(
        checks.properties,
        addedRemovedCheckKeys,
        `${path}.checks.properties`,
      );
    if ('geometryTypes' in checks)
      validateSeverities(
        checks.geometryTypes,
        addedRemovedCheckKeys,
        `${path}.checks.geometryTypes`,
      );
    for (const name of [
      'duplicateIds',
      'missingIds',
      'nullGeometries',
    ] as const) {
      if (name in checks)
        validateSeverities(
          checks[name],
          increasedCheckKeys,
          `${path}.checks.${name}`,
        );
    }
  }
  if ('thresholds' in regression) {
    const thresholds = configRecord(
      regression.thresholds,
      `${path}.thresholds`,
    );
    validateConfigKeys(
      thresholds,
      regressionThresholdKeys,
      `${path}.thresholds`,
    );
    if ('fileSizeIncrease' in thresholds)
      validateThreshold(
        thresholds.fileSizeIncrease,
        `${path}.thresholds.fileSizeIncrease`,
        'minimumIncrease',
        true,
      );
    if ('totalVerticesIncrease' in thresholds)
      validateThreshold(
        thresholds.totalVerticesIncrease,
        `${path}.thresholds.totalVerticesIncrease`,
        'minimumIncrease',
      );
    if ('featureCountDecrease' in thresholds)
      validateThreshold(
        thresholds.featureCountDecrease,
        `${path}.thresholds.featureCountDecrease`,
        'minimumDecrease',
      );
  }
}

export function validatePolicyConfig(
  value: Record<string, unknown>,
  path: string,
): void {
  if ('rules' in value) validateRules(value.rules, `${path}.rules`);
  if ('budgets' in value) configRecord(value.budgets, `${path}.budgets`);
  if ('regression' in value)
    validateRegression(value.regression, `${path}.regression`);
  if ('diagnostics' in value)
    validateDiagnostics(value.diagnostics, `${path}.diagnostics`);
}
