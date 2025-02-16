import { Construct } from 'constructs';

export interface PipelineBuilderProps {
  /**
       * Project name
       */
  readonly project: string;
}

export class PipelineBuilder extends Construct {
  constructor(scope: Construct, id: string, props: PipelineBuilderProps) {
    super(scope, id);

    console.log('props: ', JSON.stringify(props));
  }
}