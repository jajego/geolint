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

type Path = (string | number)[];
interface ValueFrame {
  readonly kind: 'value';
  readonly value: unknown;
  readonly path: Path;
}

interface ArrayFrame {
  readonly kind: 'array';
  readonly value: unknown[];
  readonly path: Path;
  index: number;
}

interface ObjectFrame {
  readonly kind: 'object';
  readonly value: object;
  readonly path: Path;
  readonly keys: readonly string[];
  index: number;
}

type Frame = ValueFrame | ArrayFrame | ObjectFrame;

function primitive(
  value: unknown,
  parentPath: Path,
  segment?: string | number,
): boolean {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true;
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      invalid(
        segment === undefined ? parentPath : [...parentPath, segment],
        'numbers must be finite',
      );
    return true;
  }
  if (typeof value !== 'object')
    invalid(
      segment === undefined ? parentPath : [...parentPath, segment],
      `${typeof value} is not part of the JSON data model`,
    );
  return false;
}

function visit(value: unknown): asserts value is JsonValue {
  const active = new Set<object>();
  const stack: Frame[] = [{ kind: 'value', value, path: [] }];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    if (frame.kind === 'array') {
      if (frame.index === frame.value.length) {
        active.delete(frame.value);
        continue;
      }
      const index = frame.index;
      frame.index += 1;
      const descriptor = Object.getOwnPropertyDescriptor(
        frame.value,
        String(index),
      );
      if (!descriptor)
        invalid([...frame.path, index], 'sparse arrays are not accepted');
      if (!descriptor.enumerable || !('value' in descriptor)) {
        invalid(
          [...frame.path, index],
          'array items must be enumerable data properties',
        );
      }
      stack.push(frame);
      if (!primitive(descriptor.value, frame.path, index)) {
        const path = [...frame.path, index];
        stack.push({ kind: 'value', value: descriptor.value, path });
      }
      continue;
    }
    if (frame.kind === 'object') {
      const key = frame.keys[frame.index];
      if (key === undefined) {
        active.delete(frame.value);
        continue;
      }
      frame.index += 1;
      const descriptor = Object.getOwnPropertyDescriptor(frame.value, key)!;
      if (!descriptor.enumerable || !('value' in descriptor)) {
        invalid(
          [...frame.path, key],
          'object members must be enumerable data properties',
        );
      }
      stack.push(frame);
      if (!primitive(descriptor.value, frame.path, key)) {
        const path = [...frame.path, key];
        stack.push({ kind: 'value', value: descriptor.value, path });
      }
      continue;
    }
    const { path } = frame;
    value = frame.value;
    if (primitive(value, path)) continue;
    const object = value as object;
    if (types.isProxy(object)) invalid(path, 'Proxy objects are not accepted');
    if (active.has(object)) invalid(path, 'cycles are not accepted');
    if (Object.getOwnPropertySymbols(object).length > 0)
      invalid(path, 'symbol properties are not accepted');

    active.add(object);
    if (Array.isArray(object)) {
      if (Object.getPrototypeOf(object) !== Array.prototype)
        invalid(path, 'arrays must be ordinary Arrays');
      // Names and descriptors inspect hostile containers without invoking getters.
      for (const key of Object.getOwnPropertyNames(object)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isSafeInteger(index) ||
          index < 0 ||
          String(index) !== key
        ) {
          if (Object.getOwnPropertyDescriptor(object, key)?.enumerable)
            invalid(
              [...path, key],
              'custom enumerable array properties are not accepted',
            );
        }
      }
      stack.push({ kind: 'array', value: object, path, index: 0 });
      continue;
    }

    const prototype = Object.getPrototypeOf(object) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      invalid(
        path,
        'objects must have Object.prototype or null as their prototype',
      );
    }
    stack.push({
      kind: 'object',
      value: object,
      path,
      keys: Object.getOwnPropertyNames(object),
      index: 0,
    });
  }
}

export function assertJsonValue(value: unknown): asserts value is JsonValue {
  visit(value);
}
