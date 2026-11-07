#!/usr/bin/env node
// An installed copy runs the compiled CLI; a checkout runs the TypeScript sources directly
// (Node.js strips types, but not under node_modules).
import { fileURLToPath } from 'node:url';

const installed = fileURLToPath(import.meta.url)
  .split(/[\\/]/)
  .includes('node_modules');
const { main } = await import(installed ? '../dist/node/cli.js' : '../src/node/cli.ts');
process.exitCode = await main(process.argv.slice(2));
