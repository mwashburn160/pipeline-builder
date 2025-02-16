import { TypeScriptProject } from 'projen/lib/typescript';
import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { AwsCdkConstructLibrary } from 'projen/lib/awscdk';

let branch = 'main';
let pnpmVersion = '10.4.0';
let esbuildVersion = '0.25.0'
let constructsVersion = '10.4.2';
let cdkVersion = '2.157.0';
let jsiiVersion = '5.7.4';
let typescriptVersion = '5.7.3';

let root = new TypeScriptProject({
  name: '@pipeline-builder/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.91.11',
  minNodeVersion: '22.13.0',
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  gitignore: ['.DS_Store', '.nx', '.vscode'],
  licensed: true,
  projenrcTs: true,
  eslint: false,
  jest: false,
  buildWorkflow: false,
  release: false,
  sampleCode: false,
  devDeps: [
    `esbuild@${esbuildVersion}`,
    `constructs@${constructsVersion}`,
    'npm-check-updates@17.1.14'
  ]
});

new AwsCdkConstructLibrary({
  parent: root,
  name: '@pipeline-builder/shared-lib',
  outdir: './packages/shared-lib',
  author: 'mark washburn',
  authorAddress: 'mwashburn160@gmail.com',
  defaultReleaseBranch: 'main',
  repositoryUrl: 'https://github.com/mrwconsulting/ci-flex.git',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  npmAccess: NpmAccess.PUBLIC,
  licensed: false,
  buildWorkflow: false,
  release: false,
  cdkVersion: cdkVersion,
  jsiiVersion: jsiiVersion,
  typescriptVersion: typescriptVersion,
  constructsVersion: constructsVersion,
  devDeps: [
    '@types/node@20.9.0',
    `constructs@${constructsVersion}`,
    `aws-cdk-lib@${cdkVersion}`
  ],
});

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});
root.synth();