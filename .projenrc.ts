import { TypeScriptProject } from 'projen/lib/typescript';
import { NodePackageManager } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';

let branch = 'main';
let pnpmVersion = '10.4.0';
let esbuildVersion = '0.25.0'
let constructsVersion = '10.4.2';

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

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });
root.addScripts({
  'npm-check': 'npx npm-check-updates'
});
root.package.addField('packageManager', `pnpm@${pnpmVersion}`);
root.synth();