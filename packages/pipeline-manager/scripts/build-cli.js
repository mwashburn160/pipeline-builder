#!/usr/bin/env node
// Bundles dist/cli.js and dist/boilerplate.js in place: inlines @mwashburn160/*
// internals, leaves every other npm dependency external so users install them
// normally. boilerplate.js is a separate Node entry point invoked by `cdk synth`
// / `cdk deploy --app="node ./boilerplate.js"`, so it needs the same treatment.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const pkg = require('../package.json');

const distDir = path.resolve(__dirname, '..', 'dist');
const cliPath = path.join(distDir, 'cli.js');
const boilerplatePath = path.join(distDir, 'boilerplate.js');

const deps = Object.keys(pkg.dependencies || {});
const external = deps.filter(name => !name.startsWith('@mwashburn160/'));

function stripShebang(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  if (original.startsWith('#!')) {
    fs.writeFileSync(filePath, original.replace(/^#![^\n]*\n/, ''));
  }
}

function bundle(entry, { addShebang }) {
  stripShebang(entry);
  esbuild.buildSync({
    entryPoints: [entry],
    outfile: entry,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    external,
    allowOverwrite: true,
    ...(addShebang ? { banner: { js: '#!/usr/bin/env node' } } : {}),
    logLevel: 'info',
  });
  if (addShebang) fs.chmodSync(entry, 0o755);
}

bundle(cliPath, { addShebang: true });
bundle(boilerplatePath, { addShebang: false });
