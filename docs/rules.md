# Built-in rules

Rule settings are `off`, `warn`, `error`, or `[severity, options]`. Built-in IDs are used without a namespace.

| Rule                               | Purpose and options                                                                                                       | Preset            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `require-feature-id`               | Require every Feature to have an ID.                                                                                      | web warning       |
| `unique-feature-id`                | Reject repeated string or numeric Feature IDs.                                                                            | recommended error |
| `consistent-feature-id-type`       | Reject documents mixing string and numeric IDs.                                                                           | recommended error |
| `consistent-property-types`        | Detect properties with inconsistent JSON types. `nullPolicy`: `compatible` (default) or `strict`.                         | recommended error |
| `consistent-property-presence`     | Require a property presence ratio. Options: `minimumPresenceRatio` (default `1`) and `minimumFeatureCount` (default `1`). | opt-in            |
| `allowed-geometry-types`           | Restrict geometries with non-empty `allow`, e.g. `['Point', 'Polygon']`.                                                  | opt-in            |
| `consistent-geometry-types`        | Detect mixed Feature geometry types.                                                                                      | web warning       |
| `no-null-geometry`                 | Report Features whose geometry is `null`.                                                                                 | web warning       |
| `valid-coordinate-range`           | Require longitude in `[-180, 180]` and latitude in `[-90, 90]`.                                                           | recommended error |
| `consistent-coordinate-dimensions` | Detect mixed 2D, 3D, and 4D+ Positions.                                                                                   | recommended error |
| `coordinate-precision`             | Limit source-level effective decimal places with `maximumDecimals` (default `6`).                                         | web warning       |

Example:

```js
export default {
  extends: ['geolint/recommended'],
  rules: {
    'consistent-property-types': ['error', { nullPolicy: 'strict' }],
    'allowed-geometry-types': ['error', { allow: ['Point', 'Polygon'] }],
  },
};
```

## Coordinate precision

This source-aware rule examines numeric lexemes, not floating-point accuracy. If `F` is the digits after the mantissa decimal and `E` is the exponent (default `0`):

```text
effectiveDecimals = max(0, F - E)
```

Thus `1e-7` is 7, `1.230000e2` is 4, `-0.000000` is 6, and `1.2e3` is 0. Parsed object input cannot provide lexemes; file/text input selects source-capable analysis automatically.
