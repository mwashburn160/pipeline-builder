import { execSync } from 'node:child_process';
import { TypeScriptModuleResolution } from 'projen/lib/javascript';
import { TypeScriptAppProject, TypeScriptProjectOptions } from 'projen/lib/typescript';

export class FunctionProject extends TypeScriptAppProject {
    private _home: string = 'api'

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            outdir: `api/${options.name}`,
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
                    module: 'NodeNext',
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
        execSync(`if [ ! -d ${this._home} ];then mkdir -p ${this._home};fi`)
    }

    postSynthesize(): void {
        execSync(`if [ -d ${this._home}/${this.name}/test ];then rm -rf ${this._home}/${this.name}/test;fi`)
    }
}