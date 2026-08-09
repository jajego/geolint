import { runComparison } from './compare.js';

process.stdout.write(await runComparison(process.argv.slice(2)));
