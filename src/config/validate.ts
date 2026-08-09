import { assertGlob } from './glob.js';
import type { GeoLintConfig } from '../types/config.js';
import { validatePlugin } from '../plugins/plugin.js';
import { validatePolicyConfig } from './validate-policy.js';
import {
  configRecord,
  configStringArray,
  invalidConfig,
  isConfigRecord,
  validateConfigKeys,
} from './validation.js';

const configKeys = new Set([
  'extends',
  'files',
  'ignores',
  'plugins',
  'rules',
  'budgets',
  'regression',
  'diagnostics',
  'overrides',
]);
const overrideKeys = new Set([
  'files',
  'ignores',
  'rules',
  'budgets',
  'regression',
  'diagnostics',
]);

function patterns(value: unknown, path: string): readonly string[] {
  const entries = configStringArray(value, path);
  for (const pattern of entries) assertGlob(pattern);
  return entries;
}

export function validateConfig(value: unknown): asserts value is GeoLintConfig {
  const config = configRecord(value, 'config');
  validateConfigKeys(config, configKeys, 'config');
  if ('extends' in config) configStringArray(config.extends, 'config.extends');
  if ('files' in config) patterns(config.files, 'config.files');
  if ('ignores' in config) patterns(config.ignores, 'config.ignores');
  if (Object.hasOwn(config, 'plugins')) {
    const pluginDescriptor = Object.getOwnPropertyDescriptor(config, 'plugins');
    const plugins = configRecord(
      pluginDescriptor && 'value' in pluginDescriptor
        ? pluginDescriptor.value
        : invalidConfig('config.plugins', 'an own data property'),
      'config.plugins',
    );
    for (const namespace of Object.keys(plugins)) {
      if (namespace.length === 0 || namespace.includes('/')) {
        invalidConfig(
          `config.plugins.${namespace || '<empty>'}`,
          'a non-empty namespace without "/"',
        );
      }
      const descriptor = Object.getOwnPropertyDescriptor(plugins, namespace);
      const plugin =
        descriptor && 'value' in descriptor
          ? descriptor.value
          : invalidConfig(
              `config.plugins.${namespace}`,
              'an own data property',
            );
      validatePlugin(plugin, `config.plugins.${namespace}`);
    }
  }
  validatePolicyConfig(config, 'config');
  if (!('overrides' in config)) return;
  if (!Array.isArray(config.overrides))
    invalidConfig('config.overrides', 'an array');
  config.overrides.forEach((candidate, index) => {
    const path = `config.overrides[${index}]`;
    const override = configRecord(candidate, path);
    validateConfigKeys(override, overrideKeys, path);
    if (!('files' in override))
      invalidConfig(`${path}.files`, 'an array of strings');
    if (patterns(override.files, `${path}.files`).length === 0) {
      invalidConfig(`${path}.files`, 'a non-empty array of strings');
    }
    if ('ignores' in override) patterns(override.ignores, `${path}.ignores`);
    validatePolicyConfig(override, path);
    if (
      isConfigRecord(override.regression) &&
      Object.hasOwn(override.regression, 'baseline')
    ) {
      invalidConfig(
        `${path}.regression.baseline`,
        'a base-config-only setting',
      );
    }
  });
}
