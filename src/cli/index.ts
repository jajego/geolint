#!/usr/bin/env node

import { parseArgs } from 'node:util';

import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    'no-config': { type: 'boolean' },
    'print-config': { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
  },
});

async function main(): Promise<void> {
  if (values.version) {
    console.log('geolint 0.0.0');
  } else if (values.help || positionals.length === 0) {
    console.log('Usage: geolint <targets...>');
  } else if (values['print-config']) {
    const config = await resolveRuntimeConfig({
      ...(values.config ? { config: values.config } : {}),
      ...(values['no-config'] ? { noConfig: true } : {}),
    });
    console.log(
      JSON.stringify(resolveFileConfig(config, positionals[0]!), null, 2),
    );
  } else {
    console.error(
      'GeoLint is not implemented yet. Phase 2 adds semantic scanning.',
    );
    process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
