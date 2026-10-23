# Changelog

## 2.0.0 (unreleased, on branch rebuild/portfolio-oct)

The 1.0.0 package on npm cannot be imported: `main` points to `lib/index.js`, but the
compiled files were published under `lib/lib/`. 2.0.0 fixes that and the construct bugs below.
Breaking changes are marked **breaking**.

Packaging and build
- Sources move to `src/`, compiled output to `lib/`. The package ships only `.js` and `.d.ts`.
- `npm run clean` no longer deletes the TypeScript sources.
- Lock file regenerated; `npm ci` failed on the old one.
- Added an ESLint config (the `lint` script had none) and `scripts/verify-package.sh`, which
  packs the library and imports it from a clean project.

APIGatewayLambda
- Creates the account-level API Gateway CloudWatch role when logging is on. Without it, the first
  deploy in a fresh account fails.
- CORS no longer sends `Allow-Credentials: true` with a `*` origin, which browsers reject.
- A route with `requiresAuth: true` and no authorizer now throws instead of deploying a public endpoint.
- `requestValidation` now creates a request validator (it was a no-op).
- Removed duplicate Lambda permissions.
- **breaking**: removed the unused `domainName` prop. It never created a domain.

AuditableStorage
- Lifecycle transitions are dropped when they would not happen before expiration. The default
  90-day retention previously produced a rule S3 rejects.
- Uploads without an encryption header are allowed (default KMS encryption applies); uploads asking
  for a non-KMS encryption type are still denied.
- Noncurrent versions now expire with the same retention.

BedrockAgentConstruct
- Permissions are granted on the handler's own role. 1.0.0 created a separate role nothing used,
  so the handler had no Bedrock access.
- Removed a dependency cycle between the function and its log group.
- Permissions are scoped to the configured model; the `foundation-model/anthropic.*` wildcard is gone.
- Supports cross-region inference profile IDs (`us.`, `eu.`, `global.`, ...).
- Invalid `logRetentionDays` values throw instead of silently becoming 30 days.
- **breaking**: `bedrockRole` is now `iam.IRole` (the handler's role). Default model is
  `us.anthropic.claude-opus-5-5`.

EventDrivenPipeline
- DLQ uses SSE-SQS. EventBridge cannot deliver to a queue encrypted with the AWS managed KMS key,
  so failed events were being lost.
- Duration alarm fires at 80% of the timeout (it was set to the timeout, which it can never exceed).

ModelCardConstruct
- Registry and S3 writes use `AwsCustomResource`. The 1.0.0 custom resource never answered
  CloudFormation, so stacks hung and then failed.
- User text is passed as data, not pasted into generated Python (quotes broke it).
- The model card JSON is now actually written to S3.
- Card names are sanitized (SageMaker rejects dots, so `1.0.0` versions failed).
- `grantUpdateStatus` works for Lambda functions and returns the grant.
- `getModelCardContent` returns real content.
- **breaking**: `responsibleTeam` and `contactEmail` no longer default to the author's details.
  Removed the invented training objective; metrics are listed in `customDetails`.

MultiTenantAuth
- Sign-up no longer fails: the trigger wrote a null value to a GSI key, which DynamoDB rejects.
- The app client can no longer write `custom:tenant_id`, `custom:tier` or `custom:plan`. Before,
  any user could set their own tenant ID and join or overwrite another tenant.
- The trigger assigns the tenant ID server side, never overwrites an existing tenant, and does not
  log user attributes.
- The authorizer is created on first use (an unattached authorizer fails synthesis).

ServerlessMLEndpoint
- S3 permissions use a real ARN. 1.0.0 put `s3://...` URLs in the IAM policy, which fails to deploy.
- Removed `AmazonSageMakerFullAccess` and the fixed role name; log permissions scoped to SageMaker log groups.
- Latency alarm threshold corrected to microseconds (it fired at 30 ms, not 30 s).
- Validates serverless memory size and concurrency.

StreamlitDashboard
- The task role no longer gets read access to every DynamoDB table and all CloudWatch metrics.
- Sets `STREAMLIT_SERVER_PORT`, health checks `/_stcore/health`, enables sticky sessions.

StripeBilling
- **breaking**: new required props `stripeSecretKeyParameterName`, `stripeLayer` and `authorizer`;
  `webhookSecret` renamed to `webhookSecretParameterName`; removed the unused `domainName` prop.
- Checkout and portal require an authorizer and take the tenant from the JWT, not the request body.
  In 1.0.0 anyone could open another tenant's billing portal.
- The Stripe secret key is read from SSM (1.0.0 never set it) and the `stripe` package comes from
  a layer (1.0.0 failed on import).
- Webhook signature header is read case-insensitively (every real webhook failed verification).
- Checkout only accepts configured price IDs; the portal return URL is fixed by the deployer.

All constructs
- Removed the `Owner: johnathan-horner` tag that was added to every user's resources.
- **breaking**: compliance modes are now `HIPAA`, `FERPA` and `SR26-2` (the Federal Reserve model risk
  guidance formerly called SR 11-7). Other modes were removed.
