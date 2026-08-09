import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { builtInRules } from '../rules/builtins.js';

test('public rule and budget references cover the V1 registries', async () => {
  const rules = await readFile('docs/rules.md', 'utf8');
  for (const rule of builtInRules)
    assert.match(rules, new RegExp(`\\b${rule.meta.name}\\b`));

  const budgets = await readFile('docs/budgets.md', 'utf8');
  for (const code of [
    'budget/file-size',
    'budget/feature-count',
    'budget/total-vertices',
    'budget/feature-vertices',
    'budget/feature-bytes',
  ])
    assert.match(budgets, new RegExp(code));
});
