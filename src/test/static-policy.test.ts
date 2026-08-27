import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRuntimeConfig } from '../config/runtime.js';
import { lintGeoJSONText } from '../engine/lint-input.js';
import { planWorkerLintTask } from '../engine/lint-files.js';
import { planPolicyRequirements } from '../engine/policy.js';
import { definePlugin } from '../plugins/plugin.js';
import { defineRule } from '../rules/define-rule.js';

async function plan(config: Parameters<typeof resolveRuntimeConfig>[0]) {
  return planPolicyRequirements(await resolveRuntimeConfig(config));
}

test('static rule event planning derives scanner requirements without create()', async () => {
  let creates = 0;
  const plugin = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      coordinate: defineRule({
        meta: { name: 'coordinate', schema: null, listensTo: ['coordinate'] },
        create() {
          creates += 1;
          return { coordinate() {} };
        },
      }),
      lexeme: defineRule({
        meta: {
          name: 'lexeme',
          schema: null,
          listensTo: ['coordinateLexeme'],
        },
        create() {
          creates += 1;
          return { coordinateLexeme() {} };
        },
      }),
      value: defineRule({
        meta: { name: 'value', schema: null, listensTo: ['propertyValue'] },
        create() {
          creates += 1;
          return { propertyValue() {} };
        },
      }),
      aggregate: defineRule({
        meta: {
          name: 'aggregate',
          schema: null,
          requires: ['propertyStats'] as const,
        },
        create() {
          creates += 1;
          return { document() {} };
        },
      }),
    },
  });
  const base = { plugins: { test: plugin } };
  const coordinate = await plan({
    config: { ...base, rules: { 'test/coordinate': 'error' } },
  });
  assert.equal(coordinate.requirements.positions, true);
  assert.equal(coordinate.requirements.numericLexemes, false);
  const lexeme = await plan({
    config: { ...base, rules: { 'test/lexeme': 'error' } },
  });
  assert.equal(lexeme.requirements.numericLexemes, true);
  const value = await plan({
    config: { ...base, rules: { 'test/value': 'error' } },
  });
  assert.equal(value.requirements.propertyValues, true);
  assert.equal(value.requirements.featureByteSpans, false);
  const aggregate = await plan({
    config: { ...base, rules: { 'test/aggregate': 'error' } },
  });
  assert.equal(aggregate.requirements.propertyStats, true);
  assert.equal(creates, 0);
});

test('static planning retains internal budgets and unknown legacy plugin state', async () => {
  const legacy = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      legacy: defineRule({
        meta: { name: 'legacy', schema: null },
        create() {
          return { coordinateLexeme() {} };
        },
      }),
    },
  });
  const planned = await plan({
    config: {
      plugins: { legacy },
      rules: { 'legacy/legacy': 'error' },
      budgets: { feature: { bytes: '1KB' } },
    },
  });
  assert.equal(planned.requirements.featureByteSpans, true);
  assert.equal(planned.unknownPluginListeners, true);
  await assert.doesNotReject(
    lintGeoJSONText('{"type":"Point","coordinates":[1e0,2]}', {
      config: {
        plugins: { legacy },
        rules: { 'legacy/legacy': 'error' },
      },
    }),
  );
});

test('static declarations are conservative for conditional listeners', async () => {
  const conditional = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      conditional: defineRule({
        meta: {
          name: 'conditional',
          schema: null,
          listensTo: ['coordinate', 'coordinateLexeme'],
        },
        create() {
          return { coordinate() {} };
        },
      }),
    },
  });
  const planned = await plan({
    config: {
      plugins: { conditional },
      rules: { 'conditional/conditional': 'error' },
    },
  });
  assert.equal(planned.requirements.numericLexemes, true);
  await assert.doesNotReject(
    lintGeoJSONText('{"type":"Point","coordinates":[1,2]}', {
      config: {
        plugins: { conditional },
        rules: { 'conditional/conditional': 'error' },
      },
    }),
  );
});

test('worker admission planning charges only possibly buffered auto work', async () => {
  const declared = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      coordinate: defineRule({
        meta: { name: 'coordinate', schema: null, listensTo: ['coordinate'] },
        create() {
          return { coordinate() {} };
        },
      }),
      lexeme: defineRule({
        meta: { name: 'lexeme', schema: null, listensTo: ['coordinateLexeme'] },
        create() {
          return { coordinateLexeme() {} };
        },
      }),
    },
  });
  const legacy = definePlugin({
    meta: { apiVersion: 1 },
    rules: {
      ordinary: defineRule({
        meta: { name: 'ordinary', schema: null },
        create() {
          return { coordinate() {} };
        },
      }),
    },
  });
  const resolved = async (config: Parameters<typeof resolveRuntimeConfig>[0]) =>
    resolveRuntimeConfig(config);
  const under50 = 1024;
  const over50 = 50 * 1024 * 1024;
  assert.deepEqual(
    planWorkerLintTask(
      await resolved({
        config: {
          plugins: { declared },
          rules: { 'declared/coordinate': 'error' },
        },
      }),
      'auto',
      under50,
    ),
    { parser: 'buffered', admission: 'buffered' },
  );
  assert.deepEqual(
    planWorkerLintTask(
      await resolved({
        config: {
          plugins: { declared },
          rules: { 'declared/lexeme': 'error' },
        },
      }),
      'auto',
      under50,
    ),
    { parser: 'indexed', admission: 'indexed' },
  );
  const legacyConfig = await resolved({
    config: { plugins: { legacy }, rules: { 'legacy/ordinary': 'error' } },
  });
  assert.deepEqual(planWorkerLintTask(legacyConfig, 'auto', under50), {
    parser: 'auto',
    admission: 'buffered-conservative-unknown',
  });
  assert.deepEqual(planWorkerLintTask(legacyConfig, 'auto', over50), {
    parser: 'indexed',
    admission: 'indexed',
  });
  const spanConfig = await resolved({
    config: {
      plugins: { legacy },
      rules: { 'legacy/ordinary': 'error' },
      budgets: { feature: { bytes: '1KB' } },
    },
  });
  assert.deepEqual(planWorkerLintTask(spanConfig, 'auto', under50), {
    parser: 'indexed',
    admission: 'indexed',
  });
  assert.deepEqual(planWorkerLintTask(legacyConfig, 'indexed', under50), {
    parser: 'indexed',
    admission: 'indexed',
  });
  assert.deepEqual(planWorkerLintTask(legacyConfig, 'buffered', over50), {
    parser: 'buffered',
    admission: 'buffered',
  });
});
