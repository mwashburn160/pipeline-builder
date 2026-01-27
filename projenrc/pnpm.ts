import path from 'path';
import { Component, Project, YamlFile } from 'projen';

export class PnpmWorkspace extends Component {
  constructor(root: Project) {
    super(root);

    new YamlFile(root, 'pnpm-workspace.yaml', {
      obj: {
        packages: root.subprojects.map(
          project => path.relative(
            root.outdir, project.outdir
          )
        ),
      },
    });
  }
}