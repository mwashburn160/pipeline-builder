import path from 'path';
import { Component, JsonFile, Project } from 'projen';

export class VscodeSettings extends Component {
  constructor(root: Project) {
    super(root);

    new JsonFile(root, '.vscode/settings.json', {
      obj: {
        'eslint.workingDirectories':
          root.subprojects.map(project => ({
            pattern: path.relative(
              root.outdir, project.outdir
            ),
          })),
      },
    });
  }
}