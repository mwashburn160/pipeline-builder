import { InputType } from "./types";
import { ConnectionSourceOptions, GitHubSourceOptions, S3SourceOptions } from "aws-cdk-lib/pipelines"

export interface InputProps {
    readonly inputType: InputType
    readonly s3Options?: S3Options,
    readonly gitHubOptions?: GitHubOptions,
    readonly connectionOptions?: ConnectionOptions
}

export interface S3Options extends S3SourceOptions {
    readonly bucketName: string
    readonly objectKey?: string
}

export interface GitHubOptions extends GitHubSourceOptions {
    readonly branch?: string
    readonly repository: string
}

export interface ConnectionOptions extends ConnectionSourceOptions {
    readonly branch?: string
    readonly repository: string
}