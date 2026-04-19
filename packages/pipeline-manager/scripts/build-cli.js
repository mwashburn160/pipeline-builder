#!/usr/bin/env node
// Bundles dist/cli.js in place: inlines @mwashburn160/* internals, leaves
// every other npm dependency external so users install them normally.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const pkg = require('../package.json');

const cliPath = path.resolve(__dirname, '..', 'dist', 'cli.js');

// Strip the existing shebang from the tsc output so esbuild's banner is the
// only one in the final bundle.
const original = fs.readFileSync(cliPath, 'utf8');
if (original.startsWith('#!')) {
  fs.writeFileSync(cliPath, original.replace(/^#![^\n]*\n/, ''));
}

const deps = Object.keys(pkg.dependencies || {});
const external = deps.filter(name => !name.startsWith('@mwashburn160/'));

esbuild.buildSync({
  entryPoints: [cliPath],
  outfile: cliPath,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  external,
  allowOverwrite: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});

fs.chmodSync(cliPath, 0o755);
