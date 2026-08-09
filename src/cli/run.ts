import { resolve } from 'node:path';

import { resolveFileConfig } from '../config/resolve.js';
import { resolveRuntimeConfig } from '../config/runtime.js';
import {
  executeLintFiles,
  type BatchExecutionOptions,
} from '../engine/lint-files.js';
import { GeoLintBatchError, GeoLintError } from '../engine/errors.js';
import { resolveBaselinePath } from '../regression/baseline-io.js';
import { snapshotBaseline } from '../regression/snapshot.js';
import { formatResolvedConfig } from '../reporters/config.js';
import { formatJson } from '../reporters/json.js';
import { formatPretty } from '../reporters/pretty.js';
import { formatSnapshot } from '../reporters/snapshot.js';
import { geolintVersion } from '../version.js';
import { parseCliArguments, type CliArguments } from './args.js';
import { resolveTargets } from '../engine/targets.js';

export interface CliOutput {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

export const help = `Usage: geolint [targets...]
       geolint snapshot [targets...]
       geolint --print-config <file>

Targets may be files, directories, supported globs, or - for stdin.
With no targets, GeoLint uses config.files from the discovered configuration.

Options:
  --config <path>          Use an explicit configuration
  --no-config              Skip configuration discovery
  --print-config <file>    Print the resolved per-file policy as JSON
  --format <pretty|json>   Select human or machine output
  --baseline <path>        Override the regression/snapshot baseline path
  --max-warnings <n>       Fail when logical warnings exceed n
  --parser <mode>          auto, buffered, or indexed
  --no-ignore              Disable top-level target ignores
  --no-color               Disable ANSI color
  --stdin-filename <path>  Give stdin a stable project-relative identity
  --debug                   Write operational detail to stderr
  --workers <n>             Set maximum per-file worker concurrency
  -h, --help               Show help
  -v, --version            Show the package version

Exit codes: 0 clean, 1 lint findings/maximum warnings, 2 operational failure.
`;

function errorText(error: unknown, debug: boolean): string {
  if (error instanceof GeoLintError) {
    const ordinary = `GeoLint error [${error.code}]:\n${error.message}\n`;
    return debug && error.stack ? `${ordinary}${error.stack}\n` : ordinary;
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = debug && error instanceof Error ? error.stack : undefined;
  return `GeoLint error [GEOLINT_CLI_ERROR]:\n${message}\n${stack ? `${stack}\n` : ''}`;
}

function lintOutput(
  result: Awaited<ReturnType<typeof executeLintFiles>>,
  args: CliArguments,
) {
  return args.format === 'json'
    ? formatJson(result)
    : formatPretty(result, {
        color: !args.noColor && Boolean(process.stdout.isTTY),
      });
}

function runtimeOptions(args: CliArguments): BatchExecutionOptions {
  return {
    ...(args.targets.length === 0 ? {} : { targets: args.targets }),
    ...(args.config ? { config: args.config } : {}),
    ...(args.noConfig ? { noConfig: true } : {}),
    ...(args.noIgnore ? { noIgnore: true } : {}),
    parser: args.parser,
    ...(args.stdinFilename ? { stdinFilename: args.stdinFilename } : {}),
    ...(args.baseline ? { baselinePath: args.baseline } : {}),
    ...(args.workers === undefined ? {} : { workers: args.workers }),
  };
}

async function printConfig(args: CliArguments): Promise<CliOutput> {
  const cwd = process.cwd();
  const config = await resolveRuntimeConfig({
    ...(args.config ? { config: args.config } : {}),
    ...(args.noConfig ? { noConfig: true } : {}),
  });
  const file =
    args.printConfig === '-'
      ? (
          await resolveTargets(
            config,
            ['-'],
            cwd,
            args.noIgnore,
            args.stdinFilename,
          )
        )[0]!.config
      : resolveFileConfig(config, resolve(cwd, args.printConfig!));
  const baselinePath = args.baseline
    ? resolve(cwd, args.baseline)
    : resolveBaselinePath(file);
  return {
    exitCode: 0,
    stdout: formatResolvedConfig(config, file, baselinePath),
    stderr: args.debug
      ? `GeoLint debug: project root: ${config.projectRoot}\n`
      : '',
  };
}

async function snapshot(args: CliArguments): Promise<CliOutput> {
  const result = await snapshotBaseline({
    ...(args.config ? { config: args.config } : {}),
    ...(args.noConfig ? { noConfig: true } : {}),
    ...(args.targets.length === 0 ? {} : { targets: args.targets }),
    ...(args.baseline ? { baselinePath: args.baseline } : {}),
    ...(args.noIgnore ? { noIgnore: true } : {}),
    ...(args.workers === undefined ? {} : { workers: args.workers }),
  });
  return {
    exitCode: 0,
    stdout:
      args.format === 'json'
        ? formatJson(result.proposal)
        : formatSnapshot(result.proposal),
    stderr: args.debug
      ? `GeoLint debug: baseline: ${result.proposal.baselinePath}\n`
      : '',
  };
}

async function lint(args: CliArguments): Promise<CliOutput> {
  const debug: string[] = [];
  const options = runtimeOptions(args);
  const execution = {
    ...options,
    ...(args.debug
      ? { debug: (message: string) => debug.push(`GeoLint debug: ${message}`) }
      : {}),
  };
  try {
    const result = await executeLintFiles(execution);
    return {
      exitCode:
        result.errorCount > 0 ||
        (args.maxWarnings !== undefined &&
          result.warningCount > args.maxWarnings)
          ? 1
          : 0,
      stdout: lintOutput(result, args),
      stderr: debug.length > 0 ? `${debug.join('\n')}\n` : '',
    };
  } catch (error) {
    if (!(error instanceof GeoLintBatchError)) throw error;
    return {
      exitCode: 2,
      stdout: lintOutput(error.partialResult, args),
      stderr: `${debug.length > 0 ? `${debug.join('\n')}\n` : ''}${error.errors.map((item) => errorText(item, args.debug)).join('')}`,
    };
  }
}

export async function runCli(argv: readonly string[]): Promise<CliOutput> {
  let args: CliArguments | undefined;
  try {
    args = parseCliArguments(argv);
    if (args.command === 'help') {
      return { exitCode: 0, stdout: help, stderr: '' };
    }
    if (args.command === 'version') {
      return {
        exitCode: 0,
        stdout: `geolint ${geolintVersion}\n`,
        stderr: '',
      };
    }
    if (args.command === 'print-config') return await printConfig(args);
    if (args.command === 'snapshot') return await snapshot(args);
    return await lint(args);
  } catch (error) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: errorText(error, args?.debug ?? false),
    };
  }
}
