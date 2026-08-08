# GeoLint

Fast quality gates for production GeoJSON.

GeoLint is in active development. Configuration and target resolution are in
place, along with structural recovery, the buffered semantic engine, V1 quality
rules and semantic budgets through the `lintGeoJSON()` and `lintGeoJSONText()`
Node APIs. Schema-v1 regression baselines and full/partial snapshot approval
are also available; snapshot execution is independent of ordinary lint policy.

```sh
npm install --save-dev geolint
npx geolint --help
npx geolint --print-config public/map.geojson
npx geolint snapshot
```
