#!/usr/bin/env node

import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

import { resolveTargets } from './targets.js';
import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import { snapshotBaseline } from '../regression/snapshot.js';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'no-config': { type: 'boolean' },
      'print-config': { type: 'string' },
      'stdin-filename': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
    },
  });

  if (values.version) {
    console.log('geolint 0.0.0');
    return;
  }
  if (values.help || (positionals.length === 0 && !values['print-config'])) {
    console.log(
      'Usage: geolint <targets...>\n       geolint snapshot [targets...]\n       geolint --print-config <file>',
    );
    return;
  }

  if (positionals[0] === 'snapshot') {
    const targets = positionals.slice(1);
    const result = await snapshotBaseline({
      ...(values.config ? { config: values.config } : {}),
      ...(values['no-config'] ? { noConfig: true } : {}),
      ...(targets.length === 0 ? {} : { targets }),
    });
    console.log(JSON.stringify(result.proposal, null, 2));
    return;
  }

  const config = await resolveRuntimeConfig({
    ...(values.config ? { config: values.config } : {}),
    ...(values['no-config'] ? { noConfig: true } : {}),
  });
  if (values['print-config']) {
    const resolved =
      values['print-config'] === '-'
        ? (
            await resolveTargets(
              config,
              ['-'],
              process.cwd(),
              false,
              values['stdin-filename'],
            )
          )[0]!.config
        : resolveFileConfig(
            config,
            resolve(process.cwd(), values['print-config']),
          );
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }

  console.error(
    'GeoLint is not implemented yet. Phase 2 adds semantic scanning.',
  );
  process.exitCode = 2;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
