import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const configNames = [
  'geolint.config.ts',
  'geolint.config.mts',
  'geolint.config.cts',
  'geolint.config.js',
  'geolint.config.mjs',
  'geolint.config.cjs',
  'geolint.config.json',
] as const;

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function discoverConfig(cwd: string): Promise<string | undefined> {
  let directory = resolve(cwd);
  while (true) {
    for (const name of configNames) {
      const candidate = resolve(directory, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
