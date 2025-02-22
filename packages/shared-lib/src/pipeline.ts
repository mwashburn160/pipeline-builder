import { Construct } from 'constructs';

export interface PipelineBuilderProps {
  readonly project: string;
  readonly organization: string;
}

export class PipelineBuilder extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);
  }
}