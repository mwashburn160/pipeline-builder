import { execSync } from "node:child_process";
import { Project, ProjectOptions } from "projen/lib/project";

export interface BackEndProjectOptions extends ProjectOptions {
    readonly architecture?: string;
    readonly location?: string
}

export class BackEndProject extends Project {
    private _home: string = './api'
    private _options: BackEndProjectOptions

    constructor(options: BackEndProjectOptions) {
        super({
            ...options,
            outdir: options.outdir || './api/backend'
        })
        this._options = {
            ...options,
            architecture: options.architecture || 'x86_64',
            location: options.location || '../sam-template/nodejs22.x'
        }
    }

    preSynthesize(): void {
        let checkFile = `${this.outdir}/samconfig.toml`
        execSync(`if [ ! -d ${this._home} ];then mkdir -p ${this._home};fi`)
        execSync(`if [ ! -f '${checkFile}' ];then cd ${this._home};sam init --name ${this.name} --architecture ${this._options.architecture} --location ${this._options.location} --no-tracing --no-application-insights --no-structured-logging --no-input;fi`)
    }

    postSynthesize(): void {}
}