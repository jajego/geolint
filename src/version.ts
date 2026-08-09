import { createRequire } from 'node:module';

const packageMetadata = createRequire(import.meta.url)('../package.json') as {
  readonly version: string;
};

export const geolintVersion = packageMetadata.version;
