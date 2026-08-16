import { defineConfig } from '@jajego/geolint';
import quality from '@fixture/geolint-plugin-quality';

export default defineConfig({
  plugins: { quality },
  rules: {
    'quality/require-feature-id': 'error',
    'quality/allowed-property-values': [
      'error',
      { property: 'status', allowed: ['active', 'planned'] },
    ],
    'quality/unique-property-value': ['error', { property: 'status' }],
    'quality/coordinate-precision': ['error', { decimals: 2 }],
  },
});
