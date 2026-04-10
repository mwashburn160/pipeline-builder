// Copyright 2026 Pipeline Builder Contributors
// SPDX-License-Identifier: Apache-2.0

import { execSync } from 'node:child_process';
import { TypeScriptModuleResolution } from 'projen/lib/javascript';
import { TypeScriptAppProject, TypeScriptProjectOptions } from 'projen/lib/typescript';
import { BASE_STRICT_COMPILER_OPTIONS } from './shared-config';

/**
 * API service / application project.
 *
 * Defaults to `api/{name}` output directory; pass `outdir` to override.
 */
export class FunctionProject extends TypeScriptAppProject {

    constructor(options: TypeScriptProjectOptions) {
        super({
            ...options,
            outdir: options.outdir ?? `api/${options.name}`,

            tsconfig: {
                compilerOptions: {
                    ...BASE_STRICT_COMPILER_OPTIONS,
                    outDir: 'lib',

                    module: 'NodeNext',
                    moduleResolution: TypeScriptModuleResolution.NODE_NEXT,
                    target: 'ESNext',
                    lib: ['ESNext'],

                    stripInternal: true,
                    noEmitOnError: false,
                }
            }
        })
    }

    preSynthesize(): void {
        execSync(`if [ ! -d ${this.outdir} ];then mkdir -p ${this.outdir};fi`)
    }

}
