/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-runtime-cycles',
      comment: 'Runtime import cycles obscure initialization order.',
      severity: 'error',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'engine-must-not-import-cli',
      comment: 'Engine code must remain usable without the CLI.',
      severity: 'error',
      from: { path: '^src/engine/' },
      to: { path: '^src/cli/' },
    },
    {
      name: 'production-must-not-import-dev-code',
      comment: 'Production code must not depend on benchmark or test code.',
      severity: 'error',
      from: { path: '^src/(?!benchmark/|test/)' },
      to: { path: '^src/(?:benchmark|test)/' },
    },
  ],
  options: { doNotFollow: { path: 'node_modules' } },
};
