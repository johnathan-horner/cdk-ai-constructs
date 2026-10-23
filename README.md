# cdk-ai-constructs

![CI](https://github.com/johnathan-horner/cdk-ai-constructs/actions/workflows/ci.yml/badge.svg)

**Status: In progress.** Version 2.0.0 builds and passes 155 tests, and every construct synthesizes
to a CloudFormation template. None of the constructs has been deployed to a live AWS account yet,
and 2.0.0 is not on npm. The published 1.0.0 cannot be imported (see [CHANGELOG.md](CHANGELOG.md)).

Independent reference project by Shoot It Analytics LLC. Built with public or synthetic data.

## What it does

A TypeScript AWS CDK library with **9 constructs** for the infrastructure around AI applications.

| Construct | What it creates |
|---|---|
| `BedrockAgentConstruct` | Bedrock invoke permissions on a Lambda function's role, scoped to one model or inference profile; log group; error alarm |
| `APIGatewayLambda` | REST API with Lambda proxy routes, optional Cognito auth per route, CORS, throttling, request validation, access logs, alarms |
| `AuditableStorage` | KMS-encrypted, versioned S3 bucket with lifecycle rules, TLS-only policy and a CloudTrail data-event trail |
| `EventDrivenPipeline` | EventBridge rule to a Lambda function with retries, an encrypted dead letter queue and alarms |
| `ModelCardConstruct` | SageMaker model card, the same card as JSON in S3, and a DynamoDB model registry entry |
| `MultiTenantAuth` | Cognito user pool with tenant attributes, a DynamoDB tenants table, a sign-up trigger, and an API Gateway authorizer |
| `ServerlessMLEndpoint` | SageMaker serverless endpoint with a scoped execution role, invoke permission for a Lambda function, alarms |
| `StreamlitDashboard` | Streamlit container on ECS Fargate behind an ALB, optional HTTPS with Route 53, autoscaling |
| `StripeBilling` | Checkout, signed webhook and customer portal Lambda functions behind API Gateway, tied to the tenants table |

No project currently imports this library. It is used only by its own examples and tests.

## Why I built this

**The problem.** Teams putting AI features on AWS rebuild the same wiring for every app: model
access, tenant isolation, audit storage, model documentation. The details are easy to get wrong in
ways that only show up later: an IAM policy that grants every model, a tenant ID a user can edit,
a log bucket rule that S3 rejects on deploy.

**What I set out to prove.** Whether a small set of CDK constructs can carry those guardrails, so a
new AI app starts with least-privilege access, tenant isolation and audit storage by default, and
whether each guardrail can be checked by an automated test before anything is deployed.

**Key design decisions**
- Scope permissions to exactly what was asked for: one Bedrock model or inference profile, one S3
  object, one SageMaker endpoint. No `anthropic.*` or account-wide wildcards in defaults.
- Tenant identity comes from the signed token, never from the request body, and users cannot edit
  their own tenant attributes.
- Fail at synth time rather than deploy time: invalid retention values, a route that needs auth with
  no authorizer, and bad SageMaker sizes throw while the template is built.
- Secrets stay in SSM Parameter Store; templates hold only parameter names.
- Every README example below is a function in `examples/per-construct.ts` that the test suite
  synthesizes, so the documentation cannot drift from the code.

**Results (measured in this repo).** See [Measured results](#measured-results).

**Limits.** Synthesis and unit tests only. No construct has been deployed to a live account, so
anything only AWS checks at deploy time (some SageMaker model card content rules, service quotas)
is untested. Compliance presets set retention periods only; they do not make a workload compliant
with any regulation. This is not a certified or regulated product and has not been used with real
customers or clients.

**What I'd do next in a real deployment.** Deploy each example to a sandbox account in CI and tear
it down, add cdk-nag checks, publish 2.0.0 with provenance, and add a jsii build so Python CDK
projects can use it.

## Architecture

```
src/
  index.ts                 exports all 9 constructs
  constructs/*.ts          one file per construct
test/
  *.test.ts                Jest + aws-cdk-lib/assertions against synthesized templates
  synth-smoke.test.ts      every construct synthesizes; inline Lambda code stays under 4096 chars
  examples.test.ts         every README example synthesizes
  python/                  pytest runs the generated Lambda handlers with fake AWS and Stripe clients
examples/
  per-construct.ts         the README examples
  basic-ai-app-stack.ts    Bedrock + API Gateway + storage in one stack
  connectiq-stack.ts       all constructs together in one sample stack
scripts/verify-package.sh  packs the library and imports it from a clean project
```

Each construct is a plain `Construct` that composes aws-cdk-lib resources. `MultiTenantAuth` and
`StripeBilling` are designed to work together (the billing construct takes the auth construct's
authorizer and tenants table).

## How to run

Requires Node.js 18 or later. `aws-cdk-lib` 2.x and `constructs` 10.x are peer dependencies.

```bash
npm ci
npm run build        # TypeScript to lib/
npm run typecheck    # src, tests and examples
npm run lint
npm test             # Jest
npm run verify-package
```

Python handler tests (need Python 3.10+ and pytest):

```bash
DUMP_INLINE_DIR=/tmp/inline npx jest test/synth-smoke.test.ts
INLINE_DIR=/tmp/inline pytest test/python
```

To use it in a CDK app once 2.0.0 is published: `npm install @johnathan-horner/cdk-ai-constructs`.

## Examples

Each snippet is copied from `examples/per-construct.ts`, where `pythonFn(scope, id)` creates a small
Python Lambda function.

### BedrockAgentConstruct

```typescript
const summarizer = pythonFn(scope, 'Summarizer');
new BedrockAgentConstruct(scope, 'Bedrock', {
  appName: 'DocsApp',
  handler: summarizer,
  modelId: 'us.anthropic.claude-sonnet-4-6', // model ID or inference profile ID
});
```

### APIGatewayLambda

```typescript
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
```

### AuditableStorage

```typescript
const reader = pythonFn(scope, 'Reader');
const storage = new AuditableStorage(scope, 'Records', {
  appName: 'DocsApp',
  bucketName: 'docs-records',
  complianceMode: 'HIPAA', // sets 7-year retention; it does not make a workload compliant
});
storage.grantRead(reader);
```

### EventDrivenPipeline

```typescript
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
```

### ModelCardConstruct

```typescript
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
```

### MultiTenantAuth

```typescript
const auth = new MultiTenantAuth(scope, 'Auth', {
  appName: 'DocsApp',
  callbackUrls: ['https://app.example.com/callback'],
  customAttributes: ['company_size'],
  mfaRequired: true,
  domainPrefix: 'docsapp-login',
});
auth.grantTenantsTableRead(pythonFn(scope, 'TenantLookup'));
```

### ServerlessMLEndpoint

```typescript
new ServerlessMLEndpoint(scope, 'Churn', {
  appName: 'DocsApp',
  modelDataUrl: 's3://my-model-bucket/churn/1.2.0/model.tar.gz',
  containerImage: '683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3',
  invokerFunction: pythonFn(scope, 'ScoreAccount'),
  memorySize: 2048,
  maxConcurrency: 5,
});
```

### StreamlitDashboard

```typescript
const dashboard = new StreamlitDashboard(scope, 'Dashboard', {
  appName: 'DocsApp',
  dockerfilePath: dockerContextDir, // directory containing the Dockerfile
  minCapacity: 1,
  maxCapacity: 2,
});
const auth = new MultiTenantAuth(scope, 'DashAuth', { appName: 'DashApp', callbackUrls: ['https://app.example.com/cb'] });
dashboard.grantDynamoDBAccess(auth.tenantsTable, ['dynamodb:GetItem', 'dynamodb:Query']);
```

### StripeBilling

```typescript
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
```

## Measured results

Measured on branch `rebuild/portfolio-oct` with `npm test`, `pytest test/python` and
`scripts/verify-package.sh`, locally and in GitHub Actions:

| Check | Result |
|---|---|
| Constructs exported | 9 |
| Jest tests | 147 passed, 0 failed (11 suites) |
| Python tests of generated Lambda handlers | 8 passed, 0 failed |
| Constructs that synthesize with minimal props | 9 of 9 |
| README examples that synthesize | 9 of 9 |
| Inline Lambda handlers under the 4096 character limit | 10 of 10 (largest 3,297) |
| Package imports from a clean project | yes, 9 constructs exported |
| npm 1.0.0 imports from a clean project | no (`MODULE_NOT_FOUND`) |
| Source of npm 1.0.0 vs. the eduai-connect folder it came from | 32 of 32 files identical |
| Constructs deployed to a live AWS account | 0 |

## Limits

- Not deployed to AWS. Tests check synthesized templates and handler logic with fakes.
- `StripeBilling` needs you to provide a Lambda layer with the `stripe` package.
- `ServerlessMLEndpoint` needs `modelDataUrl` as a literal `s3://` string so its policy can be scoped.
- `ModelCardConstruct` lists metrics in the card's custom details instead of the evaluation section,
  because the CloudFormation and SageMaker schemas disagree on that field's type.
- `AuditableStorage` and `ModelCardConstruct` each create their own CloudTrail trail, which adds
  cost if your account already has an organization trail.
- TypeScript only (no jsii build for Python, Java or .NET).

## What's next

- Deploy every example in a sandbox account from CI, then destroy it.
- cdk-nag rules in the test suite.
- Publish 2.0.0 and deprecate 1.0.0 on npm.
- jsii build for Python.

## License

MIT, see [LICENSE](LICENSE).
