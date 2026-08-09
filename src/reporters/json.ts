function project(value: unknown, seen: Set<object>): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new TypeError(
      'GeoLint JSON output cannot represent non-finite numbers.',
    );
  }
  if (typeof value !== 'object') {
    throw new TypeError(
      `GeoLint JSON output cannot represent ${typeof value}.`,
    );
  }
  if (seen.has(value)) {
    throw new TypeError('GeoLint JSON output cannot represent cyclic values.');
  }
  seen.add(value);
  try {
    if (value instanceof Map) {
      const entries = [...value.entries()];
      if (entries.some(([key]) => typeof key !== 'string')) {
        throw new TypeError('GeoLint JSON output requires string Map keys.');
      }
      return Object.fromEntries(
        entries
          .sort(([left], [right]) =>
            String(left) < String(right)
              ? -1
              : String(left) > String(right)
                ? 1
                : 0,
          )
          .map(([key, entry]) => [key, project(entry, seen)]),
      );
    }
    if (Array.isArray(value)) {
      return value.map((entry) => project(entry, seen));
    }
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('GeoLint JSON output requires plain data objects.');
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        throw new TypeError('GeoLint JSON output cannot invoke accessors.');
      }
      output[key] = project(descriptor.value, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function jsonProjection(value: unknown): unknown {
  return project(value, new Set());
}

export function formatJson(value: unknown): string {
  return `${JSON.stringify(jsonProjection(value), null, 2)}\n`;
}
