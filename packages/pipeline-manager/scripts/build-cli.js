#!/usr/bin/env node
// Bundles dist/cli.js in place: inlines @mwashburn160/* internals, leaves
// every other npm dependency external so users install them normally.
const path = require('path');
const esbuild = require('esbuild');
const pkg = require('../package.json');

const deps = Object.keys(pkg.dependencies || {});
const external = deps.filter(name => !name.startsWith('@mwashburn160/'));

esbuild.buildSync({
  entryPoints: [path.resolve(__dirname, '..', 'dist', 'cli.js')],
  outfile: path.resolve(__dirname, '..', 'dist', 'cli.js'),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external,
  allowOverwrite: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
