import {
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintError,
  GeoLintIOError,
  GeoLintInputError,
  GeoLintInternalError,
  GeoLintPluginError,
  GeoLintTargetError,
} from '../engine/errors.js';
import type { WorkerErrorEnvelope } from './protocol.js';

type GeoLintErrorConstructor = new (
  message: string,
  code: string,
  options?: ErrorOptions,
) => GeoLintError;

const errorClasses = {
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintInputError,
  GeoLintTargetError,
  GeoLintIOError,
  GeoLintInternalError,
} satisfies Readonly<Record<string, GeoLintErrorConstructor>>;

function isKnownErrorName(name: string): name is keyof typeof errorClasses {
  return Object.hasOwn(errorClasses, name);
}

export function deserializeWorkerError(
  error: WorkerErrorEnvelope,
): GeoLintError {
  const options = error.cause ? { cause: new Error(error.cause) } : undefined;
  if (error.name === 'GeoLintPluginError' && error.ruleId && error.filePath) {
    const value = new GeoLintPluginError(
      error.message,
      'GEOLINT_PLUGIN_ERROR',
      error.ruleId,
      error.filePath,
      { cause: options?.cause },
    );
    if (error.stack) value.stack = error.stack;
    return value;
  }
  const ErrorClass = isKnownErrorName(error.name)
    ? errorClasses[error.name]
    : GeoLintInternalError;
  const value = new ErrorClass(error.message, error.code, options);
  if (error.stack) value.stack = error.stack;
  return value;
}
