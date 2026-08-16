# Regression baselines

Regression is optional. A baseline records objective artifact facts (bytes, counts, geometry/property/ID summaries) and compares them with configured regression policies. It is **not** an allowlist for existing rule, budget, or plugin diagnostics: ordinary linting still reports those findings.

`baseline` only chooses where the artifact reference is stored. It does not enable comparisons by itself; configure at least one threshold or check.

By default, a regression-governed file without an entry produces visible `no baseline exists` skips. After the first snapshot, mature CI can require explicit coverage with `requireBaseline: true`; then each governed file without an approved entry fails with `regression/missing-baseline`. Files with no enabled regression policy remain unaffected, including through overrides.

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

## Create, check, and update

Create and commit the reference:

```sh
npx geolint snapshot
git add .geolint-baseline.json
```

Then run the normal check in development and CI:

```sh
npx geolint "public/**/*.geojson" --format json --max-warnings 0
```

If the team intentionally accepts a detected artifact change, run `npx geolint snapshot` again, review the printed change summary and the Git diff, and commit it. Ordinary `geolint` only checks; it never writes the baseline.

After the first committed snapshot, mature CI can require coverage:

```js
regression: {
  requireBaseline: true,
  // Keep the checks and thresholds already chosen for this project.
}
```

To approve one newly added or renamed file in strict mode without rewriting unrelated entries:

```sh
npx geolint snapshot public/new.geojson
git add .geolint-baseline.json
```

`snapshot` writes immediately. Without targets it fully replaces entries for resolved `config.files`; explicit targets perform a partial update and retain other entries. Numeric thresholds are strict: an increase must be greater than each configured percentage and minimum.

## Paths, moves, and safety

Baselines contain schema-v1 file bytes, Feature/vertex counts, largest Feature vertices, geometry distribution, selected property type/presence facts, ID quality facts, and null geometry counts. File identity is project-relative and `/`-normalized, so baseline files are deterministic, reviewable in Git, and portable across Windows, macOS, and Linux checkouts with the same paths.

When a tracked file is renamed or removed, its old entry remains until the next full snapshot. A renamed file has no matching entry; default mode shows `no baseline exists`, while strict mode fails with `regression/missing-baseline`. Run a full snapshot after reviewing moves or deletions to remove stale entries.

Baseline precedence is CLI `--baseline`, then config `regression.baseline`, then `.geolint-baseline.json`. CLI paths resolve from the current directory; config paths resolve from the project root. Stdin regression requires `--stdin-filename` so identity is stable (`GEOLINT_UNSTABLE_REGRESSION_IDENTITY` otherwise).

Missing baselines produce explicit `no-baseline` skipped-policy records until a snapshot is approved. Snapshot refuses zero targets, invalid JSON/UTF-8, and incomplete required facts; it leaves the existing baseline unchanged on operational failure. Snapshot writes are atomic and all-or-nothing for operational failures.
