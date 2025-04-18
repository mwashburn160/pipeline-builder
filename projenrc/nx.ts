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
                    projects: ['packages/*'],
                    projectsRelationship: 'fixed',
                    changelog: {
                        workspaceChangelog: {
                            file: 'false',
                            createRelease: 'github'
                        }
                    },
                    git: {
                        commitMessage: 'chore: updated version'
                    },
                    version: {
                        conventionalCommits: 'true'
                    }
                },
                affected: { defaultBase: 'origin/main' }
            },
        });
    }
}