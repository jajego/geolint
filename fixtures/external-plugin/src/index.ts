import {
  definePlugin,
  defineRule,
  optionSchema,
  type JsonPointer,
} from '@jajego/geolint';

const requireFeatureId = defineRule({
  meta: { name: 'require-feature-id', schema: null },
  create(context) {
    return {
      feature(feature) {
        if (feature.id === undefined) {
          context.report({
            message: 'Feature needs an ID.',
            path: feature.path,
          });
        }
      },
    };
  },
});

const allowedPropertyValues = defineRule({
  meta: {
    name: 'allowed-property-values',
    schema: optionSchema.object({
      property: optionSchema.string(),
      allowed: optionSchema.array(optionSchema.string()),
    }),
  },
  create(context, options) {
    return {
      propertyValue(property) {
        if (
          property.key === options.property &&
          typeof property.value === 'string' &&
          !options.allowed.includes(property.value)
        ) {
          context.report({
            message: `Property ${property.key} must be one of: ${options.allowed.join(', ')}.`,
            path: property.path,
          });
        }
      },
    };
  },
});

const uniquePropertyValue = defineRule({
  meta: {
    name: 'unique-property-value',
    schema: optionSchema.object({ property: optionSchema.string() }),
  },
  create(context, options) {
    const seen = new Map<string, string>();
    let duplicate: JsonPointer | undefined;
    return {
      propertyValue(property) {
        if (
          property.key !== options.property ||
          typeof property.value !== 'string'
        ) {
          return;
        }
        if (seen.has(property.value)) {
          duplicate ??= property.path;
        } else {
          seen.set(property.value, property.path);
        }
      },
      document() {
        if (duplicate !== undefined) {
          context.report({
            message: `Property ${options.property} must be unique.`,
            path: duplicate,
          });
        }
      },
    };
  },
});

const coordinatePrecision = defineRule({
  meta: {
    name: 'coordinate-precision',
    schema: optionSchema.object({ decimals: optionSchema.number() }),
  },
  create(context, options) {
    return {
      coordinateLexeme(coordinate) {
        const overPrecise = coordinate.rawValues.find((value) => {
          const decimal = value.indexOf('.');
          return (
            decimal !== -1 && value.length - decimal - 1 > options.decimals
          );
        });
        if (overPrecise !== undefined) {
          context.report({
            message: `Coordinate has more than ${options.decimals} decimal places.`,
            path: coordinate.path,
            ...(coordinate.byteOffset === undefined
              ? {}
              : { byteOffset: coordinate.byteOffset }),
          });
        }
      },
    };
  },
});

export default definePlugin({
  meta: { apiVersion: 1, moduleUrl: import.meta.url, exportName: 'default' },
  rules: {
    'require-feature-id': requireFeatureId,
    'allowed-property-values': allowedPropertyValues,
    'unique-property-value': uniquePropertyValue,
    'coordinate-precision': coordinatePrecision,
  },
});
