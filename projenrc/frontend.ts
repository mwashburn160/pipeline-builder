import { execSync } from 'node:child_process';
import { NextJsProject, NextJsProjectOptions } from 'projen/lib/web';

export class FrontEndProject extends NextJsProject {

    constructor(options: NextJsProjectOptions) {
        super({
            ...options,
            tailwind: false
        })
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

    postSynthesize(): void {
        execSync(`if [ -d ${this.outdir}/test ];then rm -rf ${this.outdir}/test;fi`)
    }
}