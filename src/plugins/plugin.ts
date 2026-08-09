import { GeoLintConfigError } from '../engine/errors.js';
import { validatePolicyConfig } from '../config/validate-policy.js';
import type { RuleDefinition } from '../rules/define-rule.js';
import type { GeoLintConfigFragment } from '../types/config.js';
import type { SummaryFactName } from '../types/semantic.js';

type PluginRuleDefinition = RuleDefinition<
  // The public plugin container must accept every RuleDefinition specialization.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

export interface GeoLintPlugin<
  Rules extends Readonly<Record<string, PluginRuleDefinition>> = Readonly<
    Record<string, PluginRuleDefinition>
  >,
> {
  readonly meta: {
    readonly apiVersion: 1;
    readonly moduleUrl?: string;
    readonly exportName?: string;
  };
  readonly rules: Rules;
  readonly configs?: Readonly<Record<string, GeoLintConfigFragment>>;
}

const pluginKeys = new Set(['meta', 'rules', 'configs']);
const metaKeys = new Set(['apiVersion', 'moduleUrl', 'exportName']);
const ruleMetaKeys = new Set([
  'name',
  'schema',
  'requires',
  'docs',
  'recommended',
  'performance',
]);
const fragmentKeys = new Set(['rules', 'budgets', 'regression', 'diagnostics']);
const facts = new Set<SummaryFactName>([
  'featureCount',
  'vertexCount',
  'propertyStats',
  'geometryStats',
  'idStats',
  'coordinateDimensionStats',
  'derivedExtent',
]);

function fail(path: string, expected: string): never {
  throw new GeoLintConfigError(
    `Invalid plugin definition at ${path}: expected ${expected}.`,
    'GEOLINT_INVALID_PLUGIN',
  );
}

function plainRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail(path, 'a plain object');
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    return fail(path, 'a plain object');
  }
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      fail(`${path}.${key}`, 'a data property');
    }
  }
  return value as Record<string, unknown>;
}

function own(
  record: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor
    ? descriptor.value
    : fail(`${path}.${key}`, 'an own data property');
}

function knownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail(`${path}.${unknown}`, 'a supported property');
}

function validateRule(
  value: unknown,
  localName: string,
  path: string,
): asserts value is PluginRuleDefinition {
  if (localName.length === 0 || localName.includes('/')) {
    fail(path, 'a non-empty local rule name without "/"');
  }
  const rule = plainRecord(value, path);
  knownKeys(rule, new Set(['meta', 'create']), path);
  const meta = plainRecord(own(rule, 'meta', path), `${path}.meta`);
  knownKeys(meta, ruleMetaKeys, `${path}.meta`);
  if (own(meta, 'name', `${path}.meta`) !== localName) {
    fail(`${path}.meta.name`, `the local rule name "${localName}"`);
  }
  const schema = own(meta, 'schema', `${path}.meta`);
  if (schema !== null) {
    const schemaRecord = plainRecord(schema, `${path}.meta.schema`);
    if (
      typeof own(schemaRecord, 'parse', `${path}.meta.schema`) !== 'function'
    ) {
      fail(`${path}.meta.schema.parse`, 'a function');
    }
  }
  const requires = Object.getOwnPropertyDescriptor(meta, 'requires');
  if (requires) {
    if (!('value' in requires) || !Array.isArray(requires.value)) {
      fail(`${path}.meta.requires`, 'an array of summary fact names');
    }
    for (const fact of requires.value as unknown[]) {
      if (typeof fact !== 'string' || !facts.has(fact as SummaryFactName)) {
        fail(`${path}.meta.requires`, 'an array of summary fact names');
      }
    }
  }
  const docs = Object.getOwnPropertyDescriptor(meta, 'docs');
  if (docs) {
    if (!('value' in docs)) fail(`${path}.meta.docs`, 'a data property');
    const value = plainRecord(docs.value, `${path}.meta.docs`);
    knownKeys(value, new Set(['description', 'category']), `${path}.meta.docs`);
    for (const key of ['description', 'category'] as const) {
      if (typeof own(value, key, `${path}.meta.docs`) !== 'string') {
        fail(`${path}.meta.docs.${key}`, 'a string');
      }
    }
  }
  const performance = Object.getOwnPropertyDescriptor(meta, 'performance');
  if (
    performance &&
    (!('value' in performance) || typeof performance.value !== 'string')
  ) {
    fail(`${path}.meta.performance`, 'a string');
  }
  const recommended = Object.getOwnPropertyDescriptor(meta, 'recommended');
  if (
    recommended &&
    (!('value' in recommended) || typeof recommended.value !== 'boolean')
  ) {
    fail(`${path}.meta.recommended`, 'a boolean');
  }
  if (typeof own(rule, 'create', path) !== 'function') {
    fail(`${path}.create`, 'a function');
  }
}

export function validatePlugin(
  value: unknown,
  path = 'plugin',
): asserts value is GeoLintPlugin {
  const plugin = plainRecord(value, path);
  knownKeys(plugin, pluginKeys, path);
  const meta = plainRecord(own(plugin, 'meta', path), `${path}.meta`);
  knownKeys(meta, metaKeys, `${path}.meta`);
  if (own(meta, 'apiVersion', `${path}.meta`) !== 1) {
    fail(`${path}.meta.apiVersion`, 'the supported API version 1');
  }
  const moduleUrl = Object.getOwnPropertyDescriptor(meta, 'moduleUrl');
  const exportName = Object.getOwnPropertyDescriptor(meta, 'exportName');
  if (Boolean(moduleUrl) !== Boolean(exportName)) {
    fail(`${path}.meta`, 'moduleUrl and exportName together');
  }
  for (const [descriptor, key] of [
    [moduleUrl, 'moduleUrl'],
    [exportName, 'exportName'],
  ] as const) {
    if (
      descriptor &&
      (!('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length === 0)
    ) {
      fail(`${path}.meta.${key}`, 'a non-empty string');
    }
  }
  const rules = plainRecord(own(plugin, 'rules', path), `${path}.rules`);
  for (const localName of Object.keys(rules)) {
    validateRule(
      own(rules, localName, `${path}.rules`),
      localName,
      `${path}.rules.${localName}`,
    );
  }
  const configs = Object.getOwnPropertyDescriptor(plugin, 'configs');
  if (configs) {
    if (!('value' in configs)) fail(`${path}.configs`, 'a data property');
    const entries = plainRecord(configs.value, `${path}.configs`);
    for (const [name, fragment] of Object.entries(entries)) {
      if (name.length === 0) fail(`${path}.configs`, 'non-empty config names');
      validatePluginConfigFragment(fragment, `${path}.configs.${name}`);
    }
  }
}

function validatePluginConfigFragment(value: unknown, path: string): void {
  const fragment = plainRecord(value, path);
  knownKeys(fragment, fragmentKeys, path);
  try {
    validatePolicyConfig(fragment, 'config');
  } catch (error) {
    if (error instanceof GeoLintConfigError) {
      throw new GeoLintConfigError(
        error.message.replace(
          /^Invalid configuration at config/,
          `Invalid plugin definition at ${path}`,
        ),
        'GEOLINT_INVALID_PLUGIN',
        { cause: error },
      );
    }
    throw error;
  }
}

export function definePlugin<
  const Rules extends Readonly<Record<string, PluginRuleDefinition>>,
  const Plugin extends GeoLintPlugin<Rules>,
>(plugin: Plugin): Plugin {
  validatePlugin(plugin);
  return stabilizePlugin(plugin) as Plugin;
}

export function stabilizePlugin(plugin: GeoLintPlugin): GeoLintPlugin {
  const rules = Object.fromEntries(
    Object.entries(plugin.rules).map(([name, rule]) => [
      name,
      Object.freeze({
        ...rule,
        meta: Object.freeze({
          ...rule.meta,
          ...(rule.meta.docs
            ? { docs: Object.freeze({ ...rule.meta.docs }) }
            : {}),
          ...(rule.meta.requires
            ? { requires: Object.freeze([...rule.meta.requires]) }
            : {}),
        }),
      }),
    ]),
  );
  const configs = plugin.configs
    ? Object.freeze(
        Object.fromEntries(
          Object.entries(plugin.configs).map(([name, config]) => [
            name,
            Object.freeze({
              ...(config.rules
                ? { rules: Object.freeze({ ...config.rules }) }
                : {}),
              ...(config.budgets
                ? { budgets: Object.freeze({ ...config.budgets }) }
                : {}),
              ...(config.regression
                ? { regression: Object.freeze({ ...config.regression }) }
                : {}),
              ...(config.diagnostics
                ? { diagnostics: Object.freeze({ ...config.diagnostics }) }
                : {}),
            }),
          ]),
        ),
      )
    : undefined;
  return Object.freeze({
    meta: Object.freeze({ ...plugin.meta }),
    rules: Object.freeze(rules),
    ...(configs ? { configs } : {}),
  });
}

export function samePluginIdentity(
  left: GeoLintPlugin,
  right: GeoLintPlugin,
): boolean {
  if (left === right) return true;
  return Boolean(
    left.meta.moduleUrl &&
    right.meta.moduleUrl &&
    left.meta.apiVersion === right.meta.apiVersion &&
    left.meta.moduleUrl === right.meta.moduleUrl &&
    left.meta.exportName === right.meta.exportName,
  );
}
