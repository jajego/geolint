import assert from 'node:assert/strict';
import test from 'node:test';

import { ESLint } from 'eslint';

const eslint = new ESLint({ cwd: process.cwd() });

async function ruleIds(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  return result!.messages.flatMap((message) =>
    message.ruleId ? [message.ruleId] : [],
  );
}

test('quality guardrail exceptions remain exact-file scoped', async () => {
  const asyncCallback =
    '[1].forEach(async (value) => { await Promise.resolve(value); });';
  assert.ok(
    (await ruleIds(asyncCallback, 'src/engine/policy.ts')).includes(
      '@typescript-eslint/no-misused-promises',
    ),
  );
  assert.ok(
    !(await ruleIds(asyncCallback, 'src/workers/worker-entry.ts')).includes(
      '@typescript-eslint/no-misused-promises',
    ),
  );

  const nestedTernary = 'const result = first ? 1 : second ? 2 : 3;';
  assert.ok(
    (await ruleIds(nestedTernary, 'src/benchmark/compare.ts')).includes(
      'no-nested-ternary',
    ),
  );
  assert.ok(
    !(await ruleIds(nestedTernary, 'src/parser/indexed-source.ts')).includes(
      'no-nested-ternary',
    ),
  );
});
