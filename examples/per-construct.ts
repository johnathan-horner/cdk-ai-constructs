/**
 * One short example per construct. The README shows these same snippets, and
 * test/examples.test.ts synthesizes every one of them, so they cannot drift.
 */
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
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
} from '@johnathan-horner/cdk-ai-constructs';

function pythonFn(scope: Construct, id: string): lambda.Function {
  return new lambda.Function(scope, id, {
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: 'index.handler',
    code: lambda.Code.fromInline('def handler(event, context):\n    return {"statusCode": 200}'),
  });
}

export function bedrockAgentExample(scope: Construct) {
  const summarizer = pythonFn(scope, 'Summarizer');
  new BedrockAgentConstruct(scope, 'Bedrock', {
    appName: 'DocsApp',
    handler: summarizer,
    modelId: 'us.anthropic.claude-sonnet-4-6', // model ID or inference profile ID
  });
}

export function apiGatewayLambdaExample(scope: Construct) {
  const auth = new MultiTenantAuth(scope, 'ApiAuth', { appName: 'DocsApp', callbackUrls: ['https://app.example.com/cb'] });
  new APIGatewayLambda(scope, 'Api', {
    appName: 'DocsApp',
    apiName: 'docs-api',
    cognitoAuthorizer: auth.userPool,
    corsOrigins: ['https://app.example.com'],
    throttle: { rateLimit: 50, burstLimit: 100 },
    routes: [
      { method: 'GET', path: '/health', handler: pythonFn(scope, 'Health'), requiresAuth: false },
      { method: 'GET', path: '/documents/{id}', handler: pythonFn(scope, 'GetDocument') },
      {
        method: 'POST', path: '/documents', handler: pythonFn(scope, 'CreateDocument'),
        requestValidation: { validateBody: true },
      },
    ],
  });
}

export function auditableStorageExample(scope: Construct) {
  const reader = pythonFn(scope, 'Reader');
  const storage = new AuditableStorage(scope, 'Records', {
    appName: 'DocsApp',
    bucketName: 'docs-records',
    complianceMode: 'HIPAA', // sets 7-year retention; it does not make a workload compliant
  });
  storage.grantRead(reader);
}

export function eventDrivenPipelineExample(scope: Construct) {
  const pipeline = new EventDrivenPipeline(scope, 'Uploads', {
    appName: 'DocsApp',
    ruleName: 'document-uploaded',
    eventPattern: { source: ['docs.app'], detailType: ['DocumentUploaded'] },
    targetFunction: pythonFn(scope, 'OnUpload'),
    maxRetryAttempts: 2,
    alarmEmail: 'oncall@example.com',
  });
  pipeline.createDlqProcessor({
    runtime: lambda.Runtime.PYTHON_3_12,
    handler: 'index.handler',
    code: lambda.Code.fromInline('def handler(event, context):\n    return {"batchItemFailures": []}'),
  });
}

export function modelCardExample(scope: Construct) {
  new ModelCardConstruct(scope, 'ChurnCard', {
    appName: 'DocsApp',
    modelName: 'churn-classifier',
    modelVersion: '1.2.0',
    intendedUse: 'Rank accounts by churn risk for the retention team',
    trainingDataDescription: 'Synthetic account activity, 50k rows',
    evaluationMetrics: [
      { name: 'roc_auc', value: 0.87 },
      { name: 'recall_at_10pct', value: 0.41 },
    ],
    limitations: ['Trained on synthetic data only'],
    outOfScopeUse: ['Credit or pricing decisions'],
    responsibleTeam: 'Data Science',
  });
}

export function multiTenantAuthExample(scope: Construct) {
  const auth = new MultiTenantAuth(scope, 'Auth', {
    appName: 'DocsApp',
    callbackUrls: ['https://app.example.com/callback'],
    customAttributes: ['company_size'],
    mfaRequired: true,
    domainPrefix: 'docsapp-login',
  });
  auth.grantTenantsTableRead(pythonFn(scope, 'TenantLookup'));
}

export function serverlessMlEndpointExample(scope: Construct) {
  new ServerlessMLEndpoint(scope, 'Churn', {
    appName: 'DocsApp',
    modelDataUrl: 's3://my-model-bucket/churn/1.2.0/model.tar.gz',
    containerImage: '683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3',
    invokerFunction: pythonFn(scope, 'ScoreAccount'),
    memorySize: 2048,
    maxConcurrency: 5,
  });
}

export function streamlitDashboardExample(scope: Construct, dockerContextDir: string) {
  const dashboard = new StreamlitDashboard(scope, 'Dashboard', {
    appName: 'DocsApp',
    dockerfilePath: dockerContextDir, // directory containing the Dockerfile
    minCapacity: 1,
    maxCapacity: 2,
  });
  const auth = new MultiTenantAuth(scope, 'DashAuth', { appName: 'DashApp', callbackUrls: ['https://app.example.com/cb'] });
  dashboard.grantDynamoDBAccess(auth.tenantsTable, ['dynamodb:GetItem', 'dynamodb:Query']);
}

export function stripeBillingExample(scope: Construct) {
  const auth = new MultiTenantAuth(scope, 'BillingAuth', { appName: 'DocsApp', callbackUrls: ['https://app.example.com/cb'] });
  new StripeBilling(scope, 'Billing', {
    appName: 'DocsApp',
    tiers: [
      { name: 'Starter', priceId: 'price_starter', amount: 900 },
      { name: 'Pro', priceId: 'price_pro', amount: 4900 },
    ],
    // SSM SecureString parameter names; the values never enter the template
    stripeSecretKeyParameterName: '/docsapp/stripe/secret-key',
    webhookSecretParameterName: '/docsapp/stripe/webhook-secret',
    // Layer with the stripe package, e.g. built with: pip install stripe -t layer/python
    stripeLayer: lambda.LayerVersion.fromLayerVersionArn(
      scope, 'StripeLayer', 'arn:aws:lambda:us-east-1:123456789012:layer:stripe:1'),
    authorizer: auth.authorizer,
    successUrl: 'https://app.example.com/billing/success',
    cancelUrl: 'https://app.example.com/billing/cancel',
    onPaymentSuccess: pythonFn(scope, 'OnPaid'),
    tenantsTable: auth.tenantsTable,
  });
}

/** Every example in its own stack, ready for `cdk synth`. */
export function buildAll(app: cdk.App, dockerContextDir: string): cdk.Stack[] {
  const env = { account: '123456789012', region: 'us-east-1' };
  const examples: Array<[string, (s: Construct) => void]> = [
    ['BedrockAgent', bedrockAgentExample],
    ['ApiGatewayLambda', apiGatewayLambdaExample],
    ['AuditableStorage', auditableStorageExample],
    ['EventDrivenPipeline', eventDrivenPipelineExample],
    ['ModelCard', modelCardExample],
    ['MultiTenantAuth', multiTenantAuthExample],
    ['ServerlessMlEndpoint', serverlessMlEndpointExample],
    ['StreamlitDashboard', (s) => streamlitDashboardExample(s, dockerContextDir)],
    ['StripeBilling', stripeBillingExample],
  ];
  return examples.map(([name, build]) => {
    const stack = new cdk.Stack(app, `${name}Example`, { env });
    build(stack);
    return stack;
  });
}
