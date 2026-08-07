import { types } from 'node:util';

import { GeoLintInputError } from '../engine/errors.js';
import { jsonPointer } from '../scanner/json-pointer.js';
import type { JsonValue } from '../types/semantic.js';

function invalid(path: readonly (string | number)[], reason: string): never {
  const pointer = jsonPointer(...path);
  throw new GeoLintInputError(
    `Invalid JSON value at ${pointer || '<root>'}: ${reason}.`,
    'GEOLINT_INVALID_JSON_VALUE',
  );
}

function visit(
  value: unknown,
  path: (string | number)[],
  active: Set<object>,
): asserts value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(path, 'numbers must be finite');
    return;
  }
  if (typeof value !== 'object')
    invalid(path, `${typeof value} is not part of the JSON data model`);
  if (types.isProxy(value)) invalid(path, 'Proxy objects are not accepted');
  if (active.has(value)) invalid(path, 'cycles are not accepted');
  if (Object.getOwnPropertySymbols(value).length > 0)
    invalid(path, 'symbol properties are not accepted');

  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype)
        invalid(path, 'arrays must be ordinary Arrays');
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Object.keys(descriptors)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== key
        ) {
          if (descriptors[key]?.enumerable)
            invalid(
              [...path, key],
              'custom enumerable array properties are not accepted',
            );
          continue;
        }
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor)
          invalid([...path, index], 'sparse arrays are not accepted');
        if (!descriptor.enumerable || !('value' in descriptor)) {
          invalid(
            [...path, index],
            'array items must be enumerable data properties',
          );
        }
        visit(descriptor.value, [...path, index], active);
      }
      return;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(
        path,
        'objects must have Object.prototype or null as their prototype',
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors)) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        invalid(
          [...path, key],
          'object members must be enumerable data properties',
        );
      }
      visit(descriptor.value, [...path, key], active);
    }
  } finally {
    active.delete(value);
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  visit(value, [], new Set());
}
