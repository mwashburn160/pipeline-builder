import { execSync } from "node:child_process";
import { Project, ProjectOptions } from "projen/lib/project";

export class SAMProject extends Project {
    private _architecture: string = 'x86_64'
    private _location: string = '../sam-template/nodejs22.x'
    private _home: string = './api'

    constructor(options: ProjectOptions) {
        super(options)
    }

    preSynthesize(): void {
        let checkFile = `${this.outdir}/samconfig.toml`
        execSync(`if [ ! -d ${this._home} ];then mkdir -p ${this._home};fi`)
        execSync(`if [ ! -f '${checkFile}' ];then cd ${this._home};sam init --name ${this.name} --architecture ${this._architecture} --location ${this._location} --no-tracing --no-application-insights --no-structured-logging --no-input;fi`)
    }

    postSynthesize(): void {}
}