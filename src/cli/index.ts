#!/usr/bin/env node

import { parseCliArguments } from './args.js';
import { cliHelp } from './help.js';

const argv = process.argv.slice(2);
let output;
try {
  const args = parseCliArguments(argv);
  if (args.command === 'help')
    output = { exitCode: 0, stdout: cliHelp, stderr: '' };
  else if (args.command === 'version') {
    const { geolintVersion } = await import('../version.js');
    output = { exitCode: 0, stdout: `geolint ${geolintVersion}\n`, stderr: '' };
  }
} catch {
  // Full CLI formatting owns invalid-argument errors.
}
if (!output) output = await (await import('./run.js')).runCli(argv);
if (output.stdout) process.stdout.write(output.stdout);
if (output.stderr) process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
