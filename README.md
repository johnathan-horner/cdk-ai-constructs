# cdk-ai-constructs

![CI](https://github.com/johnathan-horner/cdk-ai-constructs/actions/workflows/ci.yml/badge.svg)

**Status: Live on npm.** Version 2.0.0 is published, builds and passes 155 tests, and every construct
synthesizes to a CloudFormation template. None of the constructs has been deployed to a live AWS
account yet. npm:
https://www.npmjs.com/package/@johnathan-horner/cdk-ai-constructs (see [CHANGELOG.md](CHANGELOG.md)).

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

## Case study

Built by Johnathan Horner, Shoot It Analytics LLC. The same case study is on the [portfolio](https://portfolio.johnathancloudspace.com/#cdk-ai-constructs).

### The problem

Teams putting AI on AWS rebuild the same wiring for every project: model access, tenant isolation, audit storage, model documentation. The details are easy to get wrong, like a Bedrock policy with a wildcard or a tenant ID read from the request body.

### Why I built it

I wanted a small set of constructs that carry those guardrails by default, each checked by an automated test before anything is deployed.

### Key decisions

1. **Grant on the caller's role instead of creating new roles.** Version 1.0.0 created a role nothing used. Each construct now takes your Lambda function and grants on its role, so the permission reaches the code that calls Bedrock. The construct needs a function passed in.
2. **Scope every permission to exactly one model, endpoint or object.** No anthropic.* wildcard, and the model data URL must be a literal s3:// path. Switching models means a redeploy.
3. **Fail at synth time on invalid input.** Bad props stop the synth with a clear error, so mistakes show up in tests instead of in a half-deployed stack. The props are stricter as a result.
4. **Inline Python handlers, tested with fakes.** No build step or asset bundling. Handlers must stay under 4,096 characters (a test enforces it), and the Stripe SDK comes from a layer you supply.

### Architecture

The diagram and the flow are in [Architecture](#architecture) below.

### Governance and safety

- Least privilege by default: Bedrock access scoped to one model or inference profile, InvokeEndpoint to one endpoint.
- Tenant isolation: the tenant ID comes only from the signed token, the app client can't write tenant, tier or plan attributes, and sign-up never overwrites an existing tenant.
- Stripe webhooks are signature-checked and checkout accepts only allow-listed price IDs.
- CloudTrail data-event trails with log file validation; SSE-KMS with key rotation and TLS-only bucket policies.
- The HIPAA, FERPA and SR 26-2 modes set retention periods and tags only; they do not make a stack compliant.
- CI scans the full git history for secrets.

### Results

- 147 Jest tests in 11 suites and 8 Python tests of the generated handlers pass (run on 2026-11-16).
- All 9 constructs synthesize, and the packed 2.0.0 imports from a clean project with all 9 exported. 2.0.0 is published on npm.
- Typecheck and lint pass in CI.

### Limits

Tested by synthesis only and never deployed to a live account, and no project imports it yet.

### What I'd do in a real deployment

Deploy each construct to a sandbox account with integration tests, add jsii builds for Python users, and adopt it in one of the other projects.

### Links

- npm package: https://www.npmjs.com/package/@johnathan-horner/cdk-ai-constructs
- GitHub: https://github.com/johnathan-horner/cdk-ai-constructs
- Diagram: [docs/architecture/architecture.png](docs/architecture/architecture.png)

## Architecture

![cdk-ai-constructs: Constructs as synthesized (not deployed)](docs/architecture/architecture.png)

A stack built from the library puts API Gateway, a load balancer and Cognito at the edge, with the Stripe billing functions, Streamlit on Fargate and a sign-up trigger behind them. Your own Lambda functions get scoped grants to Bedrock, a SageMaker serverless endpoint, the model registry and a KMS-encrypted bucket, while CloudTrail records object-level events and CloudWatch alarms watch for errors. Nothing here is deployed; the diagram is what the constructs synthesize.

The diagrams are built with the Python `diagrams` library from [`docs/architecture/`](docs/architecture/). Each arrow is checked against the code and, for AWS calls, the AWS documentation; see [`docs/architecture/arrow-verification.md`](docs/architecture/arrow-verification.md). A 1200x1500 copy of each diagram (`*-linkedin.png`) is in the same folder.

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

To use it in a CDK app: `npm install @johnathan-horner/cdk-ai-constructs` (2.0.0 or later; 1.0.0 cannot be imported).

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

Measured on `main` (re-run on 2026-11-16) with `npm test`, `pytest test/python` and
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
- jsii build for Python.

## License

MIT, see [LICENSE](LICENSE).
