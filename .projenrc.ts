import { TypeScriptProject } from 'projen/lib/typescript';
import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { AwsCdkConstructLibrary } from 'projen/lib/awscdk';

let branch = 'main';
let pnpmVersion = '10.8.1';
let esbuildVersion = '0.25.2'
let constructsVersion = '10.4.2';
let cdkVersion = '2.190.0';
let jsiiVersion = '5.8.3';
let typescriptVersion = '5.8.3';

let root = new TypeScriptProject({
  name: '@mwashburn160/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.91.20',
  minNodeVersion: '22.13.0',
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  gitignore: ['.DS_Store', '.nx', '.vscode'],
  licensed: true,
  projenrcTs: true,
  jest: false,
  eslint: false,
  buildWorkflow: false,
  release: false,
  sampleCode: false,
  devDeps: [
    '@swc-node/core@1.13.3',
    '@swc-node/register@1.10.10',
    `esbuild@${esbuildVersion}`,
    `constructs@${constructsVersion}`,
    'npm-check-updates@17.1.18'
  ]
});
root.npmrc.addConfig('//npm.pkg.github.com/:_authToken', '${GITHUB_TOKEN}')
root.npmrc.addConfig('@mwashburn160:registry', 'https://npm.pkg.github.com/')
root.npmrc.addConfig('always-auth', 'true')
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});

let shared = new AwsCdkConstructLibrary({
  parent: root,
  name: '@mwashburn160/pipeline-lib',
  outdir: './packages/pipeline-lib',
  author: 'mark washburn',
  authorAddress: 'mwashburn160@gmail.com',
  defaultReleaseBranch: 'main',
  repositoryUrl: 'https://github.com/mwashburn160/pipeline-builder.git',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  npmAccess: NpmAccess.RESTRICTED,
  licensed: true,
  buildWorkflow: false,
  release: false,
  eslint: false,
  jest: false,
  cdkVersion: cdkVersion,
  jsiiVersion: jsiiVersion,
  typescriptVersion: typescriptVersion,
  constructsVersion: constructsVersion,
  devDeps: [
    '@types/node@20.9.0',
    '@types/aws-lambda@8.10.147',
    '@jest/globals@29.7.0'
  ],
});
shared.eslint?.addRules({ 'import/no-extraneous-dependencies': ['error', { 'packageDir': './', 'devDependencies': false, 'optionalDependencies': false, 'peerDependencies': false }] });

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });
root.synth();