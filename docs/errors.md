# Errors, diagnostics, and exit codes

Lint diagnostics describe artifact findings. Operational failures throw `GeoLintError` subclasses in the Node API and print stable codes on the CLI. Branch on documented classes/codes, not human-readable messages.

| Class                    | Representative stable codes                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GeoLintConfigError`     | `GEOLINT_INVALID_CONFIG`, `GEOLINT_CONFIG_NOT_FOUND`, `GEOLINT_INVALID_GLOB`, `GEOLINT_UNKNOWN_RULE`, `GEOLINT_INVALID_RULE_OPTIONS`, `GEOLINT_INVALID_PLUGIN` |
| `GeoLintCapabilityError` | `GEOLINT_CAPABILITY_NUMERIC_LEXEMES`, `GEOLINT_CAPABILITY_FEATURE_BYTES`, `GEOLINT_CAPABILITY_PLUGIN_NOT_RELOADABLE`                                           |
| `GeoLintInputError`      | `GEOLINT_INVALID_JSON_VALUE`, `GEOLINT_SNAPSHOT_INVALID_JSON`, `GEOLINT_SNAPSHOT_INCOMPLETE`                                                                   |
| `GeoLintTargetError`     | `GEOLINT_NO_TARGETS`, `GEOLINT_UNMATCHED_TARGET`, `GEOLINT_UNSTABLE_REGRESSION_IDENTITY`                                                                       |
| `GeoLintIOError`         | `GEOLINT_FILE_READ_FAILED`, `GEOLINT_BASELINE_READ_FAILED`, `GEOLINT_BASELINE_WRITE_FAILED`                                                                    |
| `GeoLintPluginError`     | `GEOLINT_PLUGIN_ERROR` with `ruleId`, `filePath`, and `cause`                                                                                                  |
| `GeoLintBatchError`      | `GEOLINT_BATCH_ERROR`, plus readonly `errors` and `partialResult`                                                                                              |

`GeoLintInternalError` represents unexpected invariant/runtime failures and is exported for typed handling, not as an expected user workflow.

## CLI exits

- `0`: no lint errors and warning threshold satisfied;
- `1`: lint, quality, budget, or regression errors, or warnings above `--max-warnings`;
- `2`: operational failure.

Warnings do not fail by default. Malformed JSON is an artifact diagnostic and therefore follows lint exit behavior rather than becoming an operational crash. `--debug` adds stack/operational detail to stderr; JSON stdout remains machine-readable.
