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

export function deserializeWorkerError(
  error: WorkerErrorEnvelope,
): GeoLintError {
  const options = error.cause ? { cause: new Error(error.cause) } : undefined;
  if (error.name === 'GeoLintPluginError' && error.ruleId && error.filePath) {
    return new GeoLintPluginError(
      error.message,
      'GEOLINT_PLUGIN_ERROR',
      error.ruleId,
      error.filePath,
      { cause: options?.cause },
    );
  }
  const ErrorClass =
    error.name === 'GeoLintCapabilityError'
      ? GeoLintCapabilityError
      : error.name === 'GeoLintConfigError'
        ? GeoLintConfigError
        : error.name === 'GeoLintInputError'
          ? GeoLintInputError
          : error.name === 'GeoLintTargetError'
            ? GeoLintTargetError
            : error.name === 'GeoLintIOError'
              ? GeoLintIOError
              : GeoLintInternalError;
  const value = new ErrorClass(error.message, error.code, options);
  if (error.stack) value.stack = error.stack;
  return value;
}
