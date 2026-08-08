import { GeoLintConfigError } from '../engine/errors.js';

export interface RuleOptionsSchema<T> {
  parse(value: unknown, path?: string): T;
}

export type InferRuleOptions<S> =
  S extends RuleOptionsSchema<infer T> ? T : never;

function fail(path: string, expected: string): never {
  throw new GeoLintConfigError(
    `Invalid rule options at ${path}: expected ${expected}.`,
    'GEOLINT_INVALID_RULE_OPTIONS',
  );
}

function schema<T>(parse: RuleOptionsSchema<T>['parse']): RuleOptionsSchema<T> {
  return Object.freeze({ parse });
}

type Shape = Readonly<Record<string, RuleOptionsSchema<unknown>>>;
type ShapeOutput<S extends Shape> = {
  readonly [K in keyof S]: InferRuleOptions<S[K]>;
};

function optional<T>(
  valueSchema: RuleOptionsSchema<T>,
): RuleOptionsSchema<T | undefined>;
function optional<T>(
  valueSchema: RuleOptionsSchema<T>,
  defaultValue: T,
): RuleOptionsSchema<T>;
function optional<T>(
  valueSchema: RuleOptionsSchema<T>,
  defaultValue?: T,
): RuleOptionsSchema<T | undefined> {
  return schema<T | undefined>((value, path = 'options') =>
    value === undefined ? defaultValue : valueSchema.parse(value, path),
  );
}

export const optionSchema = Object.freeze({
  string: () =>
    schema<string>((value, path = 'options') =>
      typeof value === 'string' ? value : fail(path, 'a string'),
    ),

  number: () =>
    schema<number>((value, path = 'options') =>
      typeof value === 'number' && Number.isFinite(value)
        ? value
        : fail(path, 'a finite number'),
    ),

  enum: <const T extends readonly [string, ...string[]]>(values: T) => {
    const allowed = new Set<string>(values);
    return schema<T[number]>((value, path = 'options') =>
      typeof value === 'string' && allowed.has(value)
        ? (value as T[number])
        : fail(path, `one of ${values.join(', ')}`),
    );
  },

  array: <T>(item: RuleOptionsSchema<T>) =>
    schema<T[]>((value, path = 'options') => {
      if (!Array.isArray(value)) fail(path, 'an array');
      return value.map((entry, index) =>
        item.parse(entry, `${path}[${index}]`),
      );
    }),

  object: <const S extends Shape>(shape: S) =>
    schema<ShapeOutput<S>>((value, path = 'options') => {
      const input = value === undefined ? {} : value;
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        fail(path, 'an object');
      }
      const record = input as Record<string, unknown>;
      const unknown = Object.keys(record).find(
        (key) => !Object.hasOwn(shape, key),
      );
      if (unknown) fail(`${path}.${unknown}`, 'a supported option');
      return Object.fromEntries(
        Object.entries(shape).map(([key, valueSchema]) => [
          key,
          valueSchema.parse(record[key], `${path}.${key}`),
        ]),
      ) as ShapeOutput<S>;
    }),

  optional,

  refine: <T>(
    valueSchema: RuleOptionsSchema<T>,
    predicate: (value: T) => boolean,
    expected: string,
  ) =>
    schema<T>((value, path = 'options') => {
      const parsed = valueSchema.parse(value, path);
      return predicate(parsed) ? parsed : fail(path, expected);
    }),
});
