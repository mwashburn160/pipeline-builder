import { Component, JsonFile } from 'projen';
import { TypeScriptProject } from 'projen/lib/typescript';

export class Nx extends Component {
    constructor(root: TypeScriptProject) {
        super(root);
        root.addDevDeps('nx@^22', '@nx/devkit@^22', '@nx/workspace@^22', '@nx/js@^22');

        new JsonFile(root, 'nx.json', {
            obj: {
                extends: 'nx/presets/npm.json',
                tasksRunnerOptions: {
                    default: {
                        runner: 'nx/tasks-runners/default',
                        options: {
                            cacheableOperations: ['build']
                        },
                        skipNxCache: true
                    },
                },
                targetDefaults: {
                    build: {
                        dependsOn: ['^build'],
                        inputs: [
                            '!{projectRoot}/lib/**/*',
                            '!{projectRoot}/dist/**/*'
                        ],
                        outputs: [
                            '{projectRoot}/lib',
                            '{projectRoot}/dist'
                        ],
                        cache: true
                    }
                },
                release: {
                    projects: ['*'],
                    projectsRelationship: 'independent',
                    releaseTagPattern: 'release/{projectName}/{version}',
                    changelog: {
                        projectChangelogs: true
                    },
                    git: {
                        commitMessage: 'chore: updated version'
                    },
                    version: {
                        conventionalCommits: 'true',
                        versionActionsOptions: {
                            skipLockFileUpdate: true
                        }
                    }
                },
                affected: { defaultBase: 'origin/main' }
            },
        });
    }
}