# GeoLint

Fast quality gates for production GeoJSON.

GeoLint is in active development. Configuration and target resolution are in
place, along with structural recovery, the buffered semantic engine, V1 quality
rules and semantic budgets through the `lintGeoJSON()` and `lintGeoJSONText()`
Node APIs.

```sh
npm install --save-dev geolint
npx geolint --help
npx geolint --print-config public/map.geojson
```
