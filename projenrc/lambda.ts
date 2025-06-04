import { execSync } from "node:child_process";
import { Project, ProjectOptions } from "projen/lib/project";

export interface LambdaFunctionOptions extends ProjectOptions {
    readonly functionName: string;
}

export class LambdaFunction extends Project {
    private _name: string
    private _architecture: string = 'x86_64'
    private _location: string = '../templates/nodejs22.x'

    constructor(options: LambdaFunctionOptions) {
        super(options)
        this._name = options.functionName
    }

    preSynthesize(): void {
        let checkFile = `./lambdas/${this._name}/samconfig.toml`
        execSync(`if [ ! -f '${checkFile}' ];then cd ./lambdas;sam init --name ${this._name} --architecture ${this._architecture} --location ${this._location} --no-tracing --no-application-insights --no-structured-logging --no-input;fi`)
    }

    postSynthesize(): void {
        execSync(`if [ -d ./lambdas/${this._name}/src ]; then rm -rf ./lambdas/${this._name}/src;fi`)
        execSync(`if [ -d ./lambdas/${this._name}/test ]; then rm -rf ./lambdas/${this._name}/test;fi`)
    }

}