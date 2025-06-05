import { Component, JsonFile } from 'projen';
import { TypeScriptProject } from 'projen/lib/typescript';

export class Nx extends Component {
    constructor(root: TypeScriptProject) {
        super(root);
        root.addDevDeps('nx@^21', '@nx/devkit@^21', '@nx/workspace@^21', '@nx/js@^21');

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
                    projects: ['*'],
                    projectsRelationship: 'independent',
                    releaseTagPattern: 'release/{projectName}/{version}',
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