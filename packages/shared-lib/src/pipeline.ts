import { Pipeline } from 'aws-cdk-lib/aws-codepipeline';
import { Construct } from 'constructs';

export interface PipelineBuilderProps {
  /**
       * Project name
       */
  readonly project: string;
  /**
       * Organization name
       */
  readonly organization: string;
}

export class PipelineBuilder extends Construct {
  private _pipeline: Pipeline;
  constructor(scope: Construct, id: string, props: PipelineBuilderProps) {
    super(scope, id);
    let str = props.organization.concat('/').concat(props.project).toUpperCase();
    let b64 = Buffer.from(str, 'utf-8').toString('base64');
    this._pipeline = new Pipeline(this, `${b64}-pipeline`, {
      pipelineName: props.project,
    });
    console.log('props: ', JSON.stringify(props));
    console.log('pipeline: ', this._pipeline);
  }
}