import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, test } from "@jest/globals";
import { PipelineBuilder, PipelineBuilderProps } from '../src/pipeline-builder'

describe('PipelineBuilder', () => {
    let app: App;
    let stack: Stack;
    let props: PipelineBuilderProps

    beforeAll(() => {
        app = new App();
        stack = new Stack(app, 'TestStack');
        props = {
            project: 'project',
            organization: 'organization',
            input: {
                inputType: 'S3',
                s3Options: {
                    bucketName: 'TestBucket'
                }
            }
        }
    });
    test('match the snapshot', () => {
        new PipelineBuilder(stack, 'TestBuilder', props)
        let template = Template.fromStack(stack);
        expect(template.toJSON()).toMatchSnapshot();
    });
})