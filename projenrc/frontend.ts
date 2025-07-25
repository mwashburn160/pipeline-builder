import { execSync } from "node:child_process";
import { NextJsTypeScriptProject, NextJsTypeScriptProjectOptions } from "projen/lib/web";

export class FrontEndProject extends NextJsTypeScriptProject {

    constructor(options: NextJsTypeScriptProjectOptions) {
        super({
            ...options,
            outdir: options.outdir || './api/frontend'
        })
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

    postSynthesize(): void {}
}