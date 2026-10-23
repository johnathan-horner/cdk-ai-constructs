/**
 * Every construct must synthesize on its own with minimal props.
 * Template.fromStack runs CDK validation, so unattached resources and
 * dependency cycles fail here.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {
  APIGatewayLambda,
  AuditableStorage,
  BedrockAgentConstruct,
  EventDrivenPipeline,
  ModelCardConstruct,
  MultiTenantAuth,
  ServerlessMLEndpoint,
  StreamlitDashboard,
  StripeBilling,
} from '../src';

function newStack(): cdk.Stack {
  return new cdk.Stack(new cdk.App(), 'Smoke', { env: { account: '123456789012', region: 'us-east-1' } });
}

function fn(stack: cdk.Stack, id = 'Fn'): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: 'index.handler',
    code: lambda.Code.fromInline('def handler(event, context):\n    return {}'),
  });
}

function dockerDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamlit-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM python:3.12-slim\n');
  return dir;
}

const cases: Array<[string, (s: cdk.Stack) => void]> = [
  ['APIGatewayLambda', (s) => new APIGatewayLambda(s, 'C', {
    appName: 'App', apiName: 'api', routes: [{ method: 'GET', path: '/items', handler: fn(s) }],
  })],
  ['AuditableStorage', (s) => new AuditableStorage(s, 'C', { appName: 'App', bucketName: 'docs' })],
  ['BedrockAgentConstruct', (s) => new BedrockAgentConstruct(s, 'C', { appName: 'App', handler: fn(s) })],
  ['EventDrivenPipeline', (s) => new EventDrivenPipeline(s, 'C', {
    appName: 'App', ruleName: 'orders', eventPattern: { source: ['app.orders'] }, targetFunction: fn(s),
  })],
  ['ModelCardConstruct', (s) => new ModelCardConstruct(s, 'C', {
    appName: 'App', modelName: 'm', modelVersion: '1.0.0', intendedUse: 'demo',
    trainingDataDescription: 'synthetic', evaluationMetrics: [{ name: 'accuracy', value: 0.9 }], limitations: ['demo'],
  })],
  ['MultiTenantAuth', (s) => new MultiTenantAuth(s, 'C', { appName: 'App', callbackUrls: ['https://example.com/cb'] })],
  ['ServerlessMLEndpoint', (s) => new ServerlessMLEndpoint(s, 'C', {
    appName: 'App', invokerFunction: fn(s),
    modelDataUrl: 's3://bucket/model.tar.gz',
    containerImage: '683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3',
  })],
  ['StreamlitDashboard', (s) => new StreamlitDashboard(s, 'C', { appName: 'App', dockerfilePath: dockerDir() })],
  ['StripeBilling', (s) => new StripeBilling(s, 'C', {
    appName: 'App',
    tiers: [{ name: 'pro', priceId: 'price_123', amount: 1000 }],
    stripeSecretKeyParameterName: '/app/stripe/secret-key',
    webhookSecretParameterName: '/app/stripe/webhook-secret',
    stripeLayer: lambda.LayerVersion.fromLayerVersionArn(s, 'StripeLayer', 'arn:aws:lambda:us-east-1:123456789012:layer:stripe:1'),
    authorizer: new MultiTenantAuth(s, 'Auth', { appName: 'App', callbackUrls: ['https://example.com/cb'] }).authorizer,
    successUrl: 'https://example.com/ok', cancelUrl: 'https://example.com/cancel',
    onPaymentSuccess: fn(s),
    tenantsTable: new dynamodb.Table(s, 'Tenants', { partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING } }),
  })],
];

describe('every construct synthesizes', () => {
  test.each(cases)('%s', (_name, build) => {
    const stack = newStack();
    build(stack);
    expect(() => Template.fromStack(stack)).not.toThrow();
  });
});

/** ZipFile is a string, or an Fn::Join when it embeds tokens; tokens become placeholders. */
function flatten(zip: unknown): string | undefined {
  if (typeof zip === 'string') return zip;
  const join = (zip as any)?.['Fn::Join'];
  if (!join) return undefined;
  return (join[1] as unknown[]).map((part) => (typeof part === 'string' ? part : 'TOKEN')).join(join[0]);
}

describe('inline Lambda code', () => {
  test.each(cases)('%s stays under the 4096 character CloudFormation limit', (_name, build) => {
    const stack = newStack();
    build(stack);
    const functions = Template.fromStack(stack).findResources('AWS::Lambda::Function');
    for (const [logicalId, fnResource] of Object.entries(functions)) {
      const zip = flatten((fnResource as any).Properties.Code.ZipFile);
      if (zip !== undefined) {
        expect(zip.length).toBeLessThanOrEqual(4096);
        if (process.env.DUMP_INLINE_DIR) {
          fs.mkdirSync(process.env.DUMP_INLINE_DIR, { recursive: true });
          fs.writeFileSync(path.join(process.env.DUMP_INLINE_DIR, `${_name}-${logicalId}.py`), zip);
        }
      }
    }
  });
});
