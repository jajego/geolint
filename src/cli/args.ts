import { parseArgs } from 'node:util';

type CliFormat = 'pretty' | 'json';

export interface CliArguments {
  readonly command: 'lint' | 'snapshot' | 'print-config' | 'help' | 'version';
  readonly targets: readonly string[];
  readonly config?: string;
  readonly noConfig: boolean;
  readonly printConfig?: string;
  readonly format: CliFormat;
  readonly baseline?: string;
  readonly maxWarnings?: number;
  readonly noColor: boolean;
  readonly noIgnore: boolean;
  readonly parser: 'auto' | 'buffered' | 'indexed';
  readonly stdinFilename?: string;
  readonly debug: boolean;
  readonly workers?: number;
}

function invalid(message: string): never {
  throw new TypeError(message);
}

export function parseCliArguments(argv: readonly string[]): CliArguments {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      baseline: { type: 'string' },
      config: { type: 'string' },
      debug: { type: 'boolean' },
      format: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'max-warnings': { type: 'string' },
      'no-color': { type: 'boolean' },
      'no-config': { type: 'boolean' },
      'no-ignore': { type: 'boolean' },
      parser: { type: 'string' },
      'print-config': { type: 'string' },
      'stdin-filename': { type: 'string' },
      version: { type: 'boolean', short: 'v' },
      workers: { type: 'string' },
    },
  });
  if (values.config && values['no-config']) {
    invalid('--config and --no-config cannot be used together.');
  }
  const format = values.format ?? 'pretty';
  if (format !== 'pretty' && format !== 'json') {
    invalid('--format must be pretty or json.');
  }
  const parser = values.parser ?? 'auto';
  if (parser !== 'auto' && parser !== 'buffered' && parser !== 'indexed') {
    invalid('--parser must be auto, buffered, or indexed.');
  }
  let maxWarnings: number | undefined;
  if (values['max-warnings'] !== undefined) {
    if (!/^\d+$/.test(values['max-warnings'])) {
      invalid('--max-warnings must be a non-negative integer.');
    }
    maxWarnings = Number(values['max-warnings']);
    if (!Number.isSafeInteger(maxWarnings)) {
      invalid('--max-warnings must be a non-negative safe integer.');
    }
  }
  let workers: number | undefined;
  if (values.workers !== undefined) {
    if (!/^[1-9]\d*$/.test(values.workers))
      invalid('--workers must be a positive integer.');
    workers = Number(values.workers);
    if (!Number.isSafeInteger(workers))
      invalid('--workers must be a positive safe integer.');
  }
  let command: CliArguments['command'] =
    positionals[0] === 'snapshot' ? 'snapshot' : 'lint';
  if (values['print-config']) command = 'print-config';
  if (values.version) command = 'version';
  if (values.help) command = 'help';
  const targets = command === 'snapshot' ? positionals.slice(1) : positionals;
  if (command === 'print-config' && positionals.length > 0) {
    invalid('--print-config cannot be combined with positional targets.');
  }
  if (
    values['stdin-filename'] &&
    command !== 'help' &&
    command !== 'version' &&
    !targets.includes('-') &&
    values['print-config'] !== '-'
  ) {
    invalid('--stdin-filename requires a stdin target (-).');
  }
  return {
    command,
    targets,
    ...(values.config ? { config: values.config } : {}),
    noConfig: values['no-config'] ?? false,
    ...(values['print-config'] ? { printConfig: values['print-config'] } : {}),
    format,
    ...(values.baseline ? { baseline: values.baseline } : {}),
    ...(maxWarnings === undefined ? {} : { maxWarnings }),
    noColor: values['no-color'] ?? false,
    noIgnore: values['no-ignore'] ?? false,
    parser,
    ...(values['stdin-filename']
      ? { stdinFilename: values['stdin-filename'] }
      : {}),
    debug: values.debug ?? false,
    ...(workers === undefined ? {} : { workers }),
  };
}
