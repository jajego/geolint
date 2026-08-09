import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GeoLintCapabilityError,
  GeoLintConfigError,
  GeoLintIOError,
  GeoLintInputError,
  GeoLintInternalError,
  GeoLintTargetError,
} from '../engine/errors.js';
import { deserializeWorkerError } from '../workers/errors.js';

test('worker error names reconstruct the complete transport error registry', () => {
  for (const [name, ErrorClass] of [
    ['GeoLintCapabilityError', GeoLintCapabilityError],
    ['GeoLintConfigError', GeoLintConfigError],
    ['GeoLintInputError', GeoLintInputError],
    ['GeoLintTargetError', GeoLintTargetError],
    ['GeoLintIOError', GeoLintIOError],
    ['GeoLintInternalError', GeoLintInternalError],
  ] as const) {
    const error = deserializeWorkerError({
      name,
      code: 'GEOLINT_TEST',
      message: 'message',
      stack: 'worker stack',
    });
    assert.ok(error instanceof ErrorClass);
    assert.equal(error.code, 'GEOLINT_TEST');
    assert.equal(error.stack, 'worker stack');
  }
});

test('unknown worker error names safely reconstruct as internal errors', () => {
  assert.ok(
    deserializeWorkerError({
      name: 'UnexpectedError',
      code: 'GEOLINT_TEST',
      message: 'message',
    }) instanceof GeoLintInternalError,
  );
});
