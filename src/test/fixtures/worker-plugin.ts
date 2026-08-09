import { definePlugin, defineRule, optionSchema } from '../../index.js';

const propertyRequired = defineRule({
  meta: {
    name: 'property-required',
    schema: optionSchema.object({ key: optionSchema.string() }),
    requires: ['propertyStats'] as const,
  },
  create(context, options) {
    return {
      document(summary) {
        if (!summary.propertyStats.has(options.key))
          context.report({ message: `Property ${options.key} is required.` });
      },
    };
  },
});

const isolatedCoordinates = defineRule({
  meta: { name: 'isolated-coordinates', schema: null },
  create(context) {
    let visits = 0;
    return {
      coordinate() {
        visits += 1;
      },
      document() {
        if (visits !== 1)
          context.report({
            message: `Expected one Position, received ${visits}.`,
          });
      },
    };
  },
});

const propertyHook = defineRule({
  meta: { name: 'property-hook', schema: null },
  create(context) {
    return {
      propertyValue(event) {
        if (event.key === 'name')
          context.report({
            message: 'Observed name.',
            featureIndex: event.featureIndex,
            path: event.path,
          });
      },
    };
  },
});

const throwing = defineRule({
  meta: { name: 'throwing', schema: null },
  create() {
    throw new Error('worker plugin failed');
  },
});

const crashing = defineRule({
  meta: { name: 'crashing', schema: null },
  create() {
    process.exit(7);
  },
});

const noisy = defineRule({
  meta: { name: 'noisy', schema: null },
  create() {
    process.stdout.write('worker stdout noise\n');
    process.stderr.write('worker stderr noise\n');
    return {};
  },
});

export default definePlugin({
  meta: {
    apiVersion: 1,
    moduleUrl: import.meta.url,
    exportName: 'default',
  },
  rules: {
    'property-required': propertyRequired,
    'isolated-coordinates': isolatedCoordinates,
    'property-hook': propertyHook,
    throwing,
    crashing,
    noisy,
  },
});
