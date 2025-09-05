import { execSync } from "node:child_process";
import { TypeScriptAppProject,TypeScriptProjectOptions } from "projen/lib/typescript";

export class FunctionProject extends TypeScriptAppProject {
    private _home: string = 'api/backend'

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            outdir: `api/backend/${options.name}`
        })
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this._home} ];then mkdir -p ${this._home};fi`)
        this.addScripts({
            'docker:build': `docker build -t $\{REPOSITORY_NAME:-${this.name}\}:$\{REPOSITORY_TAG:-latest\} .`,
            'docker:run': `docker run -p $\{EXPRESS_PORT:-3000\}:3000 $\{REPOSITORY_NAME:-${this.name}\}:$\{REPOSITORY_TAG:-latest\}`
        })
    }

    postSynthesize(): void { 
        execSync(`if [ -d ${this._home}/${this.name}/test ];then rm -rf ${this._home}/${this.name}/test;fi`)
    }
}