import { NodePackageManager, NpmAccess } from 'projen/lib/javascript';
import { PnpmWorkspace } from './projenrc/pnpm';
import { VscodeSettings } from './projenrc/vscode';
import { Nx } from './projenrc/nx';
import { Workflow } from './projenrc/workflow';
import { FunctionProject } from './projenrc/function';
import { ManagerProject } from './projenrc/manager';
import { FrontEndProject } from './projenrc/frontend'
import { TypeScriptProject } from 'projen/lib/typescript';
import { PackageProject } from './projenrc/package';
import { WebTokenProject } from './projenrc/web-token';

let branch = 'main';
let pnpmVersion = '10.25.0';
let constructsVersion = '10.4.5';
let typescriptVersion = '5.9.3';
let expressVersion = '5.2.1'
let cdkVersion = '2.236.0';
let libVersion = '0.1.32';

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
  gitignore: ['.DS_Store', '.nx', '.lock', '.next', '.vscode', 'dist', 'test-reports', 'db-data', 'pgadmin-data', 'registry-data', '.aws-sam'],
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
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'helmet@8.1.0',
    'cors@2.8.6',
    'axios@1.13.3',
    'uuid@13.0.0'
  ],
  devDeps: [
    '@types/node@24.9.0',
    '@types/aws-lambda@8.10.159',
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
lib.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
lib.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });

let manager = new ManagerProject({
  parent: root,
  name: '@mwashburn160/pipeline-manager',
  outdir: './packages/pipeline-manager',
  defaultReleaseBranch: 'main',
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  repository: 'git+https://github.com/mwashburn160/pipeline-builder.git',
  releaseToNpm: false,
  npmAccess: NpmAccess.RESTRICTED,
  bin: {
    'pipeline-manager': './dist/cli.js'
  },
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `typescript@${typescriptVersion}`,
    `aws-cdk-lib@${cdkVersion}`,
    'form-data@4.0.5',
    'commander@14.0.2',
    'figlet@1.10.0',
    'axios@1.13.3',
    'progress@2.0.3',
    'picocolors@1.1.1',
    'yaml@2.8.2',
    'ora@9.1.0'
  ],
  devDeps: [
    '@types/figlet@1.7.0',
    '@types/progress@2.0.7',
    'copyfiles@2.4.1'
  ]
})
manager.eslint?.addRules({ '@typescript-eslint/no-shadow': 'off' });
manager.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });
manager.postCompileTask.exec('copyfiles -f ./cdk.json dist/ --verbose --error');
manager.postCompileTask.exec('copyfiles -f ./config.yml dist/ --verbose --error');

let platform = new WebTokenProject({
  parent: root,
  name: 'platform',
  outdir: './platform',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'nodemailer@7.0.13',
    'jsonwebtoken@9.0.3',
    'slugify@1.6.6',
    'winston@3.19.0',
    'bcryptjs@3.0.3',
    'mongoose@9.1.5',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0',
    'yaml@2.8.2',
    'adm-zip@0.5.16',
    'multer@2.0.2'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/express-serve-static-core@5.1.1',
    '@types/nodemailer@7.0.9',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@types/adm-zip@0.5.7',
    '@types/multer@2.0.0',
    '@jest/globals@30.2.0'
  ]
});
platform.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-jwt}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-platform}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-platform}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-platform}:$(jq -r .version package.json)'
});
platform.eslint?.addRules({ '@typescript-eslint/member-ordering': 'off' });
platform.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

let frontend = new FrontEndProject({
  parent: root,
  name: 'frontend',
  outdir: './frontend',
  defaultReleaseBranch: branch,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  gitignore: ['.DS_Store', 'yarn.lock', '.next', '.vscode', 'dist'],
  deps: [
    'next@14.2.0',
    'react@18.2.0',
    'react-dom@18.2.0',
    'lucide-react@0.563.0',
    'clsx@^2.1.1',
    'tailwind-merge@3.4.0'
  ],
  devDeps: [
    '@types/node@24.9.0',
    '@types/react@19.2.10',
    '@types/react-dom@19.2.3',
    '@tailwindcss/postcss@4.1.18',
    'autoprefixer@10.4.23',
    'postcss@8.5.6',
    `typescript@${typescriptVersion}`
  ]
})
frontend.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-jwt}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-frontend}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-frontend}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-frontend}:$(jq -r .version package.json)'
});

let upload_plugin = new FunctionProject({
  parent: root,
  name: 'upload-plugin',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0',
    'yaml@2.8.2',
    'adm-zip@0.5.16',
    'multer@2.0.2'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@types/adm-zip@0.5.7',
    '@types/multer@2.0.0',
    '@jest/globals@30.2.0'
  ]
});
upload_plugin.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-upload-plugin}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-upload-plugin}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-upload-plugin}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-upload-plugin}:$(jq -r .version package.json)'
});
upload_plugin.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

let get_plugin = new FunctionProject({
  parent: root,
  name: 'get-plugin',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
get_plugin.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-get-plugin}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-get-plugin}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-get-plugin}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-get-plugin}:$(jq -r .version package.json)'
});
get_plugin.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

let list_plugins = new FunctionProject({
  parent: root,
  name: 'list-plugins',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
list_plugins.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-list-plugins}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-list-plugins}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-list-plugins}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-list-plugins}:$(jq -r .version package.json)'
});
list_plugins.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

let create_pipeline = new FunctionProject({
  parent: root,
  name: 'create-pipeline',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0',
    'yaml@2.8.2'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
create_pipeline.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-create-pipeline}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-create-pipeline}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-create-pipeline}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-create-pipeline}:$(jq -r .version package.json)'
});
create_pipeline.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

let get_pipeline = new FunctionProject({
  parent: root,
  name: 'get-pipeline',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0',
    'yaml@2.8.2'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
get_pipeline.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-get-pipeline}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-get-pipeline}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-get-pipeline}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-get-pipeline}:$(jq -r .version package.json)'
});
get_pipeline.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

let list_pipelines = new FunctionProject({
  parent: root,
  name: 'list-pipelines',
  defaultReleaseBranch: branch,
  packageManager: root.package.packageManager,
  projenCommand: root.projenCommand,
  minNodeVersion: root.minNodeVersion,
  typescriptVersion: typescriptVersion,
  deps: [
    `@mwashburn160/pipeline-lib@${libVersion}`,
    `express@${expressVersion}`,
    'express-rate-limit@8.2.1',
    'jsonwebtoken@9.0.3',
    'helmet@8.1.0',
    'cors@2.8.6',
    'pg@8.16.3',
    'drizzle-orm@0.45.1',
    'uuid@13.0.0',
    'yaml@2.8.2'
  ],
  devDeps: [
    '@types/express@5.0.6',
    '@types/jsonwebtoken@9.0.10',
    '@types/cors@2.8.19',
    '@types/node@25.0.6',
    '@types/pg@8.16.0',
    '@jest/globals@30.2.0'
  ]
});
list_pipelines.addScripts({
  'start': 'node lib/index.js',
  'docker:build': 'docker buildx build --no-cache --pull --load --build-arg WORKSPACE=${WORKSPACE:-./} --secret id=npmrc,src=$(npm get userconfig) -t ${PROJECT_NAME:-list-pipelines}:$(jq -r .version package.json) .',
  'docker:tag': 'docker image tag ${PROJECT_NAME:-list-pipelines}:$(jq -r .version package.json) ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-list-pipelines}:$(jq -r .version package.json)',
  'docker:push': 'docker push ${REGISTRY:-ghcr.io/mwashburn160}/${PROJECT_NAME:-list-pipelines}:$(jq -r .version package.json)'
});
list_pipelines.eslint?.addRules({ 'import/no-extraneous-dependencies': 'off' });

new Nx(root);
new PnpmWorkspace(root);
new VscodeSettings(root);
new Workflow(root, { pnpmVersion });

root.synth();