import { TypeScriptProject } from 'projen/lib/typescript';
import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { AwsCdkConstructLibrary } from 'projen/lib/awscdk';
import { LambdaFunction } from './projenrc/lambda';

let branch = 'main';
let pnpmVersion = '10.11.1';
let esbuildVersion = '0.25.5'
let constructsVersion = '10.4.2';
let cdkVersion = '2.190.0';
let jsiiVersion = '5.8.3';
let typescriptVersion = '5.8.3';

let root = new TypeScriptProject({
  name: '@mwashburn160/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.92.9',
  minNodeVersion: '22.15.0',
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  gitignore: ['.DS_Store', '.nx', '.vscode','db-data','pgadmin-data','.aws-sam'],
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
    'npm-check-updates@18.0.1'
  ]
});
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});

let shared = new AwsCdkConstructLibrary({
  parent: root,
  outdir: './packages/pipeline-lib',
  name: '@mwashburn160/pipeline-lib',
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
    '@types/node@22.15.3',
    '@types/aws-lambda@8.10.149',
    '@jest/globals@29.7.0'
  ],
});
shared.eslint?.addRules({ 'import/no-extraneous-dependencies': ['error', { 'packageDir': './', 'devDependencies': false, 'optionalDependencies': false, 'peerDependencies': false }] });

let listPlugins = new LambdaFunction({
  parent: root,
  outdir: './lambdas/list-plugins',
  name: '@mwashburn160/list-plugins',
  functionName: 'list-plugins',
  defaultReleaseBranch: branch,
  devDeps: [
    '@types/node@22.15.3',
    '@types/aws-lambda@8.10.149',
    '@jest/globals@29.7.0'
  ],
})
listPlugins.eslint?.addRules({ 'import/no-extraneous-dependencies': ['error', { 'packageDir': './', 'devDependencies': false, 'optionalDependencies': false, 'peerDependencies': false }] });
 
new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });
root.synth();