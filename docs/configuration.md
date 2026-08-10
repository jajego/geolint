# Configuration and CLI

GeoLint searches the current directory and then parent directories for, in order, `geolint.config.ts`, `.mts`, `.cts`, `.js`, `.mjs`, `.cjs`, or `.json`. TypeScript and module configs are loaded as executable code. The nearest discovered file defines the project root.

```js
import { defineConfig } from '@jajego/geolint';

export default defineConfig({
  extends: ['geolint/recommended'],
  files: ['public/**/*.geojson'],
  ignores: ['public/archive/**'],
  rules: {
    'require-feature-id': 'warn',
    'allowed-geometry-types': ['error', { allow: ['Point', 'Polygon'] }],
  },
  budgets: { fileSize: '2MB', totalVertices: 250_000 },
  diagnostics: { maxPerCodePerFile: 50, maxPerFile: 500 },
  overrides: [
    {
      files: ['public/large/**'],
      budgets: { fileSize: '8MB' },
    },
  ],
});
```

`files`, `ignores`, override selectors, and config-relative baseline paths resolve from the project root. Explicit CLI targets and `--baseline` resolve from the invocation directory. Overrides accumulate in declaration order.

## Presets and zero config

With no discovered or explicit config, GeoLint automatically uses `geolint/recommended`. Once a config exists, it is authoritative: add `extends: ['geolint/recommended']` explicitly to retain those defaults.

`geolint/recommended` enables sensible structural quality checks but no numeric delivery budgets. `geolint/web` extends recommended and adds warnings for missing IDs, mixed geometry types, null geometries, and coordinates exceeding six effective decimal places. Source-aware analysis is selected automatically.

Use `--config path` to select a config and `--no-config` to skip discovery. `--print-config file.geojson` prints the resolved JSON-safe policy for one file.

## CLI

Targets may be files, directories, supported GeoLint globs, or `-` for stdin. With no targets, `config.files` is used.

| Option                             | Meaning                                                        |
| ---------------------------------- | -------------------------------------------------------------- |
| `--config <path>`                  | Use an explicit config                                         |
| `--no-config`                      | Skip config discovery and use recommended zero-config defaults |
| `--print-config <file>`            | Print the effective per-file policy                            |
| `--format pretty\|json`            | Human or schema-v1 machine output                              |
| `--workers <n>`                    | Explicit maximum file-level concurrency                        |
| `--baseline <path>`                | Override the regression/snapshot baseline                      |
| `snapshot [targets...]`            | Write a full or targeted baseline update                       |
| `--max-warnings <n>`               | Fail when logical warnings exceed the limit                    |
| `--no-color`                       | Disable ANSI color                                             |
| `--no-ignore`                      | Disable top-level config ignores                               |
| `--parser auto\|buffered\|indexed` | Select source execution strategy; `auto` is recommended        |
| `--stdin-filename <path>`          | Give stdin a stable project-relative identity                  |
| `--debug`                          | Write operational details to stderr                            |

GeoLint automatically uses the cheapest capable source strategy. It parallelizes qualifying multi-file workloads; one file is never split across workers. Explicit `--workers 1` is sequential.

JSON output has `schemaVersion: 1` and contains aggregate counts plus ordered per-file diagnostics, suppression summaries, skipped policies, and semantic summaries. Diagnostic defaults retain at most 50 findings per code/file and 500 per file; logical counts include suppressed findings.
