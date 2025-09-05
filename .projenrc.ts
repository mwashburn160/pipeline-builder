import { TypeScriptProject } from 'projen/lib/typescript';
import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { AwsCdkConstructLibrary } from 'projen/lib/awscdk';
import { FrontEndProject } from './projenrc/frontend';
import { FunctionProject } from './projenrc/function';

let branch = 'main';
let pnpmVersion = '10.11.1';
let esbuildVersion = '0.25.8'
let constructsVersion = '10.4.2';
let cdkVersion = '2.190.0';
let jsiiVersion = '5.9.1';
let typescriptVersion = '5.9.2';
let expressVersion = '5.1.0';
let typeExpressVersion = '5.0.3';

let root = new TypeScriptProject({
  name: '@mwashburn160/root',
  defaultReleaseBranch: branch,
  projenVersion: '0.95.2',
  minNodeVersion: '22.15.0',
  packageManager: NodePackageManager.PNPM,
  projenCommand: 'pnpm dlx projen',
  depsUpgradeOptions: { workflow: false },
  gitignore: ['.DS_Store', '.nx', '.vscode', 'db-data', 'pgadmin-data', '.aws-sam'],
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
    'npm-check-updates@18.0.2'
  ]
});
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});

let lib = new AwsCdkConstructLibrary({
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
    '@types/node@24.0.4',
    '@types/aws-lambda@8.10.149',
    '@types/pg@8.15.5',
    '@types/dotenv@8.2.3',
    '@jest/globals@29.7.0',
    'dotenv@17.2.2',
    'pg@8.16.3',
    'drizzle-orm@0.44.5'
  ]
});
lib.eslint?.addRules({ 'import/no-extraneous-dependencies': ['error', { 'packageDir': './', 'devDependencies': false, 'optionalDependencies': false, 'peerDependencies': false }] });

new FrontEndProject({
  parent: root,
  name: 'frontend',
  defaultReleaseBranch: 'main'
})

new FunctionProject({
  parent: root,
  name: 'add-plugin',
  defaultReleaseBranch: 'main',
  devDeps:[
    `@types/express@${typeExpressVersion}`,
  ],
  deps: [
    `express@${expressVersion}`
  ]
})

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });
root.synth();