import { execSync } from 'node:child_process'
import { TypeScriptAppProject, TypeScriptProjectOptions } from 'projen/lib/typescript';

export class ManagerProject extends TypeScriptAppProject {

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            tsconfig: {
                compilerOptions: {
                    rootDir: 'src',
                    outDir: 'dist',
                    alwaysStrict: true,
                    declaration: true,
                    esModuleInterop: true,
                    experimentalDecorators: true,
                    inlineSourceMap: true,
                    inlineSources: true,
                    lib: ['ES2024'],
                    module: 'CommonJS',
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
                    target: 'ES2024',
                    allowJs: true,
                    forceConsistentCasingInFileNames: true,
                    noUncheckedIndexedAccess: true,
                    skipLibCheck: true,
                    declarationMap: true,
                    types: ['node']
                },
                include: [
                    'src/*'
                ],
                exclude: [
                    'dist',
                    'node_modules',
                    '**/*.spec.ts',
                    '**/*.test.ts'
                ]
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