# Delivery budgets and metrics

Budgets are opt-in policy checks over facts GeoLint computes. They are separate from structural diagnostics and quality rules; presets intentionally contain no universal numeric budgets.

```js
export default {
  budgets: {
    fileSize: { limit: '2MB', severity: 'error' },
    featureCount: 50_000,
    totalVertices: 250_000,
    feature: {
      vertices: 25_000,
      bytes: { limit: '300KB', severity: 'warn' },
    },
  },
};
```

| Config field       | Diagnostic                | Meaning                                                    |
| ------------------ | ------------------------- | ---------------------------------------------------------- |
| `fileSize`         | `budget/file-size`        | Exact encoded file bytes; source-aware                     |
| `featureCount`     | `budget/feature-count`    | Number of Features                                         |
| `totalVertices`    | `budget/total-vertices`   | All encoded Positions, including ring closures             |
| `feature.vertices` | `budget/feature-vertices` | Largest individual Feature vertex count                    |
| `feature.bytes`    | `budget/feature-bytes`    | Exact encoded bytes of an individual Feature; source-aware |

Bare values use error severity. Setting objects accept `limit` and `severity`; `false` disables an inherited budget. Byte units are case-sensitive: `B`, `KB`, `MB`, `GB`, `KiB`, `MiB`, and `GiB`.

Budget numbers are deployment decisions, not universal GeoJSON best practices. A tile or small lookup artifact and a national dataset need different limits. Violations appear in ordinary diagnostics and contribute to warning/error counts and CLI exit status.
