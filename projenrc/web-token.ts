import { execSync } from "node:child_process";
import { TypeScriptModuleResolution } from "projen/lib/javascript";
import { TypeScriptAppProject, TypeScriptProjectOptions } from "projen/lib/typescript";

export class WebTokenProject extends TypeScriptAppProject {

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    lib: ['ESNext'],
                    target: 'ESNext',
                    module: 'NodeNext',
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    outDir: 'lib',
                    rootDir: 'src',
                    strict: true,
                    esModuleInterop: true,
                    skipLibCheck: true,
                }
            }
        })
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

    postSynthesize(): void {
        execSync(`if [ -d ${this.outdir}/test ];then rm -rf ${this.outdir}/test;fi`)
    }
}