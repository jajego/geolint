# Regression baselines

Regression is optional. Start with ordinary linting, then enable only the comparisons useful to your delivery workflow.

```js
export default {
  extends: ['geolint/recommended'],
  files: ['public/**/*.geojson'],
  regression: {
    baseline: '.geolint-baseline.json',
    thresholds: {
      fileSizeIncrease: { percentage: 10, minimumIncrease: '20KB' },
      totalVerticesIncrease: { percentage: 10, minimumIncrease: 1_000 },
    },
    checks: {
      properties: { removed: 'error' },
      propertyTypes: { widened: 'warn', changed: 'error' },
      duplicateIds: { increased: 'error' },
    },
  },
};
```

Create and commit a baseline:

```sh
npx geolint snapshot
npx geolint "public/**/*.geojson"
```

`snapshot` without targets is a full replacement for resolved `config.files`; explicit targets perform a partial update and retain other entries. Review the printed proposal and committed baseline diff. Update it intentionally after approving artifact changes.

Baselines contain schema-v1 file bytes, Feature/vertex counts, largest Feature vertices, geometry distribution, selected property type/presence facts, ID quality facts, and null geometry counts. File identity is project-relative and `/`-normalized.

Baseline precedence is CLI `--baseline`, then config `regression.baseline`, then `.geolint-baseline.json`. CLI paths resolve from the current directory; config paths resolve from the project root. Stdin regression requires `--stdin-filename` so identity is stable (`GEOLINT_UNSTABLE_REGRESSION_IDENTITY` otherwise).

Missing baselines produce explicit `no-baseline` skipped-policy records until a snapshot is approved. Snapshot writes are atomic and all-or-nothing for operational failures.
