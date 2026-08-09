#!/usr/bin/env node

import { runCli } from './run.js';

const output = await runCli(process.argv.slice(2));
if (output.stdout) process.stdout.write(output.stdout);
if (output.stderr) process.stderr.write(output.stderr);
process.exitCode = output.exitCode;
