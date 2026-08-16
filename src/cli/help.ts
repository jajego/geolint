export const cliHelp = `Usage: geolint [targets...]
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
