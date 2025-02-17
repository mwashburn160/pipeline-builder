import { Template } from 'aws-cdk-lib/assertions';
import { App, Stack } from 'aws-cdk-lib/core';
import { PipelineBuilder, PipelineBuilderProps } from '../src/pipeline';

describe('PipelineBuilder', () => {
  let props: PipelineBuilderProps;

  beforeEach(() => {
    props = {
      project: 'Project',
      organization: 'Organization',
    };
  });
  test('Synthesizes the way we expect', () => {
    let app = new App();
    let stack = new Stack(app);
    new PipelineBuilder(stack, 'PipelineBuilder', props);

    let template = Template.fromStack(stack);
    expect(template.toJSON()).toMatchSnapshot();
  });
});