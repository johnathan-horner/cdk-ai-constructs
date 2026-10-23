import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { BedrockAgentConstruct, bedrockModelArns } from '../src/constructs/bedrock-agent';
import { outputIds } from './helpers';

describe('BedrockAgentConstruct', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let testFunction: lambda.Function;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    testFunction = new lambda.Function(stack, 'TestFunction', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context): pass'),
    });
  });

  function bedrockStatement(template: Template): any {
    const policies = template.findResources('AWS::IAM::Policy');
    for (const policy of Object.values(policies) as any[]) {
      const st = policy.Properties.PolicyDocument.Statement.find((s: any) => s.Sid === 'BedrockInvokePermissions');
      if (st) return { statement: st, roles: policy.Properties.Roles };
    }
    throw new Error('no Bedrock statement found');
  }

  test('synthesizes without a dependency cycle', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });
    expect(() => Template.fromStack(stack)).not.toThrow();
  });

  test("grants Bedrock access on the handler's own execution role", () => {
    const agent = new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });
    const template = Template.fromStack(stack);

    const { roles } = bedrockStatement(template);
    const handlerRoleId = stack.getLogicalId(testFunction.role!.node.defaultChild as cdk.CfnElement);
    expect(roles).toEqual([{ Ref: handlerRoleId }]);
    expect(agent.bedrockRole).toBe(testFunction.role);
    // No extra, unused role is created.
    template.resourceCountIs('AWS::IAM::Role', 1);
  });

  test('scopes a foundation model ID to exactly that model', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', {
      appName: 'TestApp',
      handler: testFunction,
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    });

    const { statement } = bedrockStatement(Template.fromStack(stack));
    expect(statement.Action).toEqual(['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream']);
    expect(statement.Resource).toBe('arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-3-haiku-20240307-v1:0');
  });

  test('scopes an inference profile to the profile and its underlying model', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', {
      appName: 'TestApp',
      handler: testFunction,
      modelId: 'us.anthropic.claude-sonnet-4-6',
    });

    const { statement } = bedrockStatement(Template.fromStack(stack));
    expect(statement.Resource).toEqual([
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6',
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6',
    ]);
  });

  test('defaults to the Claude Opus 5.5 US inference profile', () => {
    const agent = new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });
    expect(agent.modelId).toBe('us.anthropic.claude-opus-5-5');
  });

  test('never grants other models through a wildcard', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction, modelId: 'anthropic.m-1' });
    const json = JSON.stringify(bedrockStatement(Template.fromStack(stack)).statement.Resource);
    expect(json).not.toContain('anthropic.*');
  });

  test('allows custom Bedrock actions', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', {
      appName: 'TestApp',
      handler: testFunction,
      allowedActions: ['bedrock:InvokeModel', 'bedrock:Converse'],
    });
    expect(bedrockStatement(Template.fromStack(stack)).statement.Action).toEqual(['bedrock:InvokeModel', 'bedrock:Converse']);
  });

  test('sets model and log group environment variables on the handler', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', {
      appName: 'TestApp',
      handler: testFunction,
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
    });

    Template.fromStack(stack).hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          MODEL_ID: 'anthropic.claude-3-haiku-20240307-v1:0',
          LOG_LEVEL: 'INFO',
          BEDROCK_LOG_GROUP: { Ref: Match.stringLikeRegexp('TestAgentBedrockLogGroup') },
        },
      },
    });
  });

  test('creates a log group with the requested retention', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction, logRetentionDays: 14 });
    Template.fromStack(stack).hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 14 });
  });

  test('rejects a retention value CloudWatch does not accept', () => {
    expect(() => new BedrockAgentConstruct(stack, 'TestAgent', {
      appName: 'TestApp', handler: testFunction, logRetentionDays: 45,
    })).toThrow(/not a CloudWatch Logs retention value/);
  });

  test('creates CloudWatch alarm for errors', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });

    Template.fromStack(stack).hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TestApp-bedrock-lambda-errors',
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Threshold: 5,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
    });
  });

  test('grantBedrockAccess adds to the handler role', () => {
    const agent = new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });
    agent.grantBedrockAccess(['bedrock:ApplyGuardrail'], ['arn:aws:bedrock:us-east-1:123456789012:guardrail/abc']);

    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'AdditionalBedrockPermissions', Action: 'bedrock:ApplyGuardrail' }),
        ]),
      },
    });
  });

  test('creates required CfnOutputs', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });
    const ids = outputIds(Template.fromStack(stack)).join(' ');
    for (const name of ['BedrockRoleArn', 'LogGroupName', 'ModelId', 'ErrorAlarmArn']) {
      expect(ids).toContain(name);
    }
  });

  test('tags the resources it creates', () => {
    new BedrockAgentConstruct(stack, 'TestAgent', { appName: 'TestApp', handler: testFunction });
    Template.fromStack(stack).hasResourceProperties('AWS::Logs::LogGroup', {
      Tags: Match.arrayWith([
        { Key: 'Component', Value: 'BedrockAgent' },
        { Key: 'ManagedBy', Value: 'cdk-ai-constructs' },
        { Key: 'Project', Value: 'TestApp' },
      ]),
    });
  });

  test('bedrockModelArns handles the global profile prefix', () => {
    expect(bedrockModelArns(stack, 'global.anthropic.claude-haiku-5-5')).toEqual([
      'arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-haiku-5-5',
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-haiku-5-5',
    ]);
  });
});
