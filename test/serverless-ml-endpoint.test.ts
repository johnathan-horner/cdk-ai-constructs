import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ServerlessMLEndpoint, ServerlessMLEndpointProps, parseS3Url } from '../src/constructs/serverless-ml-endpoint';

describe('ServerlessMLEndpoint', () => {
  let stack: cdk.Stack;
  let invoker: lambda.Function;

  beforeEach(() => {
    stack = new cdk.Stack(new cdk.App(), 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
    invoker = new lambda.Function(stack, 'Invoker', {
      runtime: lambda.Runtime.PYTHON_3_12, handler: 'index.handler', code: lambda.Code.fromInline('x = 1'),
    });
  });

  const props = (extra: Partial<ServerlessMLEndpointProps> = {}): ServerlessMLEndpointProps => ({
    appName: 'TestApp',
    invokerFunction: invoker,
    modelDataUrl: 's3://model-bucket/models/churn/model.tar.gz',
    containerImage: '683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3',
    endpointName: 'churn-endpoint',
    ...extra,
  });

  function statementsOf(template: Template, roleFragment: string): any[] {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies)
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes(roleFragment))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  }

  test('creates model, serverless endpoint config and endpoint', () => {
    new ServerlessMLEndpoint(stack, 'Endpoint', props({ memorySize: 3072, maxConcurrency: 10 }));
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SageMaker::Model', {
      PrimaryContainer: Match.objectLike({ ModelDataUrl: 's3://model-bucket/models/churn/model.tar.gz' }),
    });
    template.hasResourceProperties('AWS::SageMaker::EndpointConfig', {
      ProductionVariants: [Match.objectLike({ ServerlessConfig: { MaxConcurrency: 10, MemorySizeInMB: 3072 } })],
    });
    template.hasResourceProperties('AWS::SageMaker::Endpoint', { EndpointName: 'churn-endpoint' });
  });

  test('scopes S3 access to the model artifact ARN', () => {
    new ServerlessMLEndpoint(stack, 'Endpoint', props());
    const s3 = statementsOf(Template.fromStack(stack), 'ExecutionRole').find((s) => s.Sid === 'S3ModelDataAccess');
    expect(s3.Action).toBe('s3:GetObject');
    expect(s3.Resource).toBe('arn:aws:s3:::model-bucket/models/churn/model.tar.gz');
  });

  test('does not attach AmazonSageMakerFullAccess or a fixed role name', () => {
    new ServerlessMLEndpoint(stack, 'Endpoint', props());
    const role = Object.values(Template.fromStack(stack).findResources('AWS::IAM::Role', {
      Properties: { AssumeRolePolicyDocument: { Statement: [Match.objectLike({ Principal: { Service: 'sagemaker.amazonaws.com' } })] } },
    }))[0] as any;
    expect(JSON.stringify(role.Properties.ManagedPolicyArns ?? [])).not.toContain('SageMakerFullAccess');
    expect(role.Properties.RoleName).toBeUndefined();
  });

  test('scopes log permissions to SageMaker log groups', () => {
    new ServerlessMLEndpoint(stack, 'Endpoint', props());
    const logs = statementsOf(Template.fromStack(stack), 'ExecutionRole').find((s) => s.Sid === 'CloudWatchAccess');
    expect(JSON.stringify(logs.Resource)).toContain(':log-group:/aws/sagemaker/*');
  });

  test('grants the invoker InvokeEndpoint on this endpoint only', () => {
    new ServerlessMLEndpoint(stack, 'Endpoint', props());
    const st = statementsOf(Template.fromStack(stack), 'InvokerServiceRole').find((s) => s.Sid === 'SageMakerInvokeEndpoint');
    expect(st.Action).toBe('sagemaker:InvokeEndpoint');
    expect(st.Resource).toBe('arn:aws:sagemaker:us-east-1:123456789012:endpoint/churn-endpoint');
  });

  test('latency alarm threshold is 30 seconds in microseconds', () => {
    new ServerlessMLEndpoint(stack, 'Endpoint', props());
    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ModelLatency',
      Threshold: 30_000_000,
    });
  });

  test.each([512, 1500, 8192])('rejects memorySize %d', (memorySize) => {
    expect(() => new ServerlessMLEndpoint(stack, 'Endpoint', props({ memorySize }))).toThrow(/memorySize/);
  });

  test.each([0, 201])('rejects maxConcurrency %d', (maxConcurrency) => {
    expect(() => new ServerlessMLEndpoint(stack, 'Endpoint', props({ maxConcurrency }))).toThrow(/maxConcurrency/);
  });

  test('parseS3Url', () => {
    expect(parseS3Url('s3://b/k/model.tar.gz')).toEqual({ bucket: 'b', key: 'k/model.tar.gz' });
    expect(() => parseS3Url('https://b.s3.amazonaws.com/k')).toThrow(/s3:\/\/bucket\/key/);
    expect(() => parseS3Url(cdk.Lazy.string({ produce: () => 's3://b/k' }))).toThrow(/literal/);
  });
});
