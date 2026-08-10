# Contributing to GeoLint

GeoLint requires Node.js 22 or newer and npm.

```sh
npm ci
npm run check
npm test
npm run test:conformance
npm run build
```

`npm run check` runs TypeScript, ESLint, dependency-boundary/cycle checks, and dead-code analysis. `npm run test:conformance` is the Semantic Conformance Suite; parser, scanner, recovery, ordering, or source-fact changes need focused conformance coverage.

Run `npm run benchmark` for performance-sensitive changes. Use the extended and worker benchmarks when memory, parser strategy, or parallel execution is affected, and explain material changes in the pull request.

Keep pull requests focused, add semantic tests for behavior changes, preserve stable error codes and deterministic ordering, and update public documentation when a public contract changes. Complexity and single responsibility remain review judgments rather than numeric lint gates.

See [docs/releasing.md](docs/releasing.md) for maintainer releases.
