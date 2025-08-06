import { execSync } from "node:child_process";
import { TypeScriptProject, TypeScriptProjectOptions } from "projen/lib/typescript";

export class LayerProject extends TypeScriptProject {
    private _home: string = './api/src/layers'

    constructor(options: TypeScriptProjectOptions) {
        super(options)
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this._home} ];then mkdir ${this._home};fi`)
    }

    postSynthesize(): void { 
        execSync(`if [ -d ${this.outdir}/test ];then rm -rf ${this.outdir}/test;fi`)
    }
}