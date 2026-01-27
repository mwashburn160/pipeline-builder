import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { TypeScriptProject } from 'projen/lib/typescript';
import { PackageProject } from './projenrc/package';

let branch = 'main';
let pnpmVersion = '10.25.0';
let constructsVersion = '10.4.5';
let typescriptVersion = '5.9.3';
let expressVersion = '5.2.1'
let cdkVersion = '2.234.0';

let root = new TypeScriptProject({
  name: '@mwashburn160/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.99.8',
  minNodeVersion: '24.9.0',
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  depsUpgrade: true,
  typescriptVersion: typescriptVersion,
  gitignore: ['.DS_Store', '.nx', '.vscode', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam'],
  licensed: true,
  projenrcTs: true,
  jest: false,
  eslint: false,
  buildWorkflow: false,
  release: false,
  sampleCode: false,
  npmAccess: NpmAccess.RESTRICTED,
  devDeps: [
    '@swc-node/core@1.14.1',
    '@swc-node/register@1.11.1',
    `constructs@${constructsVersion}`,
    'npm-check-updates@19.3.2'
  ]
});
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});

let lib = new PackageProject({
  parent: root,
  name: '@mwashburn160/pipeline-lib',
  outdir: './packages/pipeline-lib',
  defaultReleaseBranch: 'main',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
  deps: [
    `constructs@${constructsVersion}`,
    `aws-cdk-lib@${cdkVersion}`,
    `express@${expressVersion}`,
    'jsonwebtoken@9.0.3',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'axios@1.13.2',
    'uuid@13.0.0'
  ],
  devDeps: [
    '@types/node@24.9.0',
    '@types/aws-lambda@8.10.159',
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
lib.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
lib.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });

root.synth();