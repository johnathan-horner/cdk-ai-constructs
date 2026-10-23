import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EventDrivenPipeline } from '../src/constructs/event-driven-pipeline';
import { outputIds } from './helpers';

describe('EventDrivenPipeline', () => {
  let stack: cdk.Stack;
  let fn: lambda.Function;

  beforeEach(() => {
    stack = new cdk.Stack(new cdk.App(), 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
    fn = new lambda.Function(stack, 'Processor', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(e, c): pass'),
      timeout: cdk.Duration.seconds(60),
    });
  });

  const build = (extra: object = {}) => new EventDrivenPipeline(stack, 'Pipeline', {
    appName: 'TestApp',
    ruleName: 'orders',
    eventPattern: { source: ['app.orders'], detailType: ['OrderPlaced'] },
    targetFunction: fn,
    ...extra,
  });

  test('creates a rule on the default bus with the given pattern', () => {
    build();
    Template.fromStack(stack).hasResourceProperties('AWS::Events::Rule', {
      Name: 'TestApp-orders',
      EventPattern: { 'source': ['app.orders'], 'detail-type': ['OrderPlaced'] },
      State: 'ENABLED',
    });
  });

  test('targets the function with retries and a dead letter queue', () => {
    build({ maxRetryAttempts: 5 });
    Template.fromStack(stack).hasResourceProperties('AWS::Events::Rule', {
      Targets: [Match.objectLike({
        RetryPolicy: { MaximumRetryAttempts: 5, MaximumEventAgeInSeconds: 7200 },
        DeadLetterConfig: { Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('DeadLetterQueue'), 'Arn'] } },
      })],
    });
  });

  test('encrypts the DLQ with SSE-SQS, which EventBridge can deliver to', () => {
    build();
    const queue = Object.values(Template.fromStack(stack).findResources('AWS::SQS::Queue'))[0] as any;
    expect(queue.Properties.SqsManagedSseEnabled).toBe(true);
    expect(queue.Properties.KmsMasterKeyId).toBeUndefined();
  });

  test('lets EventBridge send to the DLQ', () => {
    build();
    Template.fromStack(stack).hasResourceProperties('AWS::SQS::QueuePolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'sqs:SendMessage', Principal: { Service: 'events.amazonaws.com' } }),
        ]),
      },
    });
  });

  test('duration alarm fires at 80% of the function timeout, not at the timeout', () => {
    build();
    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Duration',
      Threshold: 48000,
    });
  });

  test('alarms on any message in the DLQ', () => {
    build();
    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TestApp-orders-dlq-messages',
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    });
  });

  test('sends alarms to email when an address is given', () => {
    build({ alarmEmail: 'ops@example.com' });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'ops@example.com' });
    const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm')) as any[];
    expect(alarms.every((a) => (a.Properties.AlarmActions ?? []).length === 1)).toBe(true);
  });

  test('creates no topic without an email', () => {
    build();
    Template.fromStack(stack).resourceCountIs('AWS::SNS::Topic', 0);
  });

  test('createDlqProcessor reads from the DLQ', () => {
    const pipeline = build();
    pipeline.createDlqProcessor({
      runtime: lambda.Runtime.PYTHON_3_12, handler: 'index.handler', code: lambda.Code.fromInline('x = 1'),
    });
    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      EventSourceArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('DeadLetterQueue'), 'Arn'] },
      FunctionResponseTypes: ['ReportBatchItemFailures'],
    });
  });

  test('creates required CfnOutputs', () => {
    build();
    const ids = outputIds(Template.fromStack(stack)).join(' ');
    for (const name of ['EventRuleArn', 'EventRuleName', 'DeadLetterQueueUrl', 'DeadLetterQueueArn']) {
      expect(ids).toContain(name);
    }
  });
});
