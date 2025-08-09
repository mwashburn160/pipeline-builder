import { execSync } from "node:child_process";
import { TypeScriptProject, TypeScriptProjectOptions } from "projen/lib/typescript";

export class FunctionProject extends TypeScriptProject {
    private _home: string = './api/backend/src/functions'

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    outDir: 'dist',
                    paths: {
                        '/opt/nodejs/*': ['./*']
                    }
                }
            },
            gitignore: ['.aws-sam']
        })
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this._home} ];then mkdir -p ${this._home};fi`)
    }

    postSynthesize(): void { 
        execSync(`if [ -d ${this.outdir}/test ];then rm -rf ${this.outdir}/test;fi`)
    }
}