import { execSync } from 'node:child_process';
import { TypeScriptModuleResolution } from 'projen/lib/javascript';
import { TypeScriptProject, TypeScriptProjectOptions } from 'projen/lib/typescript';

export class PackageProject extends TypeScriptProject {

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    rootDir: 'src',
                    outDir: 'lib',
                    alwaysStrict: true,
                    declaration: true,
                    esModuleInterop: true,
                    experimentalDecorators: true,
                    inlineSourceMap: true,
                    inlineSources: true,
                    lib: ['ESNext'],
                    module: TypeScriptModuleResolution.NODE_NEXT,
                    noEmitOnError: false,
                    noFallthroughCasesInSwitch: true,
                    noImplicitAny: true,
                    noImplicitReturns: true,
                    noImplicitThis: true,
                    noUnusedLocals: true,
                    noUnusedParameters: true,
                    resolveJsonModule: true,
                    strict: true,
                    strictNullChecks: true,
                    strictPropertyInitialization: true,
                    stripInternal: true,
                    target: 'ESNext',
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    skipLibCheck: true
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