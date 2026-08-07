# GeoLint

Fast quality gates for production GeoJSON.

GeoLint is in active development. Configuration and target resolution are in
place, along with the buffered semantic engine and the `lintGeoJSON()` and
`lintGeoJSONText()` Node API foundations. Structural validation and built-in
rules are coming next.

```sh
npm install --save-dev geolint
npx geolint --help
npx geolint --print-config public/map.geojson
```
