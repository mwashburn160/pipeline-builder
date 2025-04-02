import { Component, JsonFile } from 'projen';
import { TypeScriptProject } from 'projen/lib/typescript';

export class Nx extends Component {
    constructor(root: TypeScriptProject) {
        super(root);
        root.addDevDeps('nx@^20', '@nx/devkit@^20', '@nx/workspace@^20', '@nx/js@^20');

        new JsonFile(root, 'nx.json', {
            obj: {
                extends: 'nx/presets/npm.json',
                tasksRunnerOptions: {
                    default: {
                        runner: 'nx/tasks-runners/default',
                        options: {
                            cacheableOperations: ['build']
                        },
                    },
                },
                targetDefaults: {
                    build: {
                        dependsOn: ['^build'],
                        inputs: [
                            '!{projectRoot}/dist/**/*',
                            '!{projectRoot}/lib/**/*'
                        ],
                        outputs: [
                            '{projectRoot}/dist',
                            '{projectRoot}/lib'
                        ],
                        cache: true
                    }
                },
                release: {
                    projects: ['packages/*'],
                    projectsRelationship: 'independent',
                    changelog: {
                        projectChangelogs: true
                    },
                    git: {
                        tag: true,
                        commit: true
                    },
                    version: {
                        generatorOptions: {
                            currentVersionResolver: 'git-tag',
                            specifierSource: 'conventional-commits'
                        }
                    },
                    releaseTagPattern: 'release/{projectName}/{version}'
                },
                affected: { defaultBase: 'origin/main' }
            },
        });
    }
}