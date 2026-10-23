import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Stripe pricing tier configuration
 */
export interface StripeTier {
  /**
   * Display name for the tier
   */
  readonly name: string;

  /**
   * Stripe price ID
   */
  readonly priceId: string;

  /**
   * Amount in cents (for display purposes)
   */
  readonly amount: number;

  /**
   * Currency code
   * @default "usd"
   */
  readonly currency?: string;

  /**
   * Billing interval
   * @default "month"
   */
  readonly interval?: string;
}

/**
 * Properties for StripeBilling construct
 */
export interface StripeBillingProps {
  /**
   * Application name for consistent naming and tagging
   */
  readonly appName: string;

  /**
   * Array of pricing tiers with Stripe price IDs. Checkout only accepts these price IDs.
   */
  readonly tiers: StripeTier[];

  /**
   * Name of an SSM SecureString parameter holding the Stripe secret API key (sk_...).
   * @example "/myapp/stripe/secret-key"
   */
  readonly stripeSecretKeyParameterName: string;

  /**
   * Name of an SSM SecureString parameter holding the Stripe webhook signing secret (whsec_...).
   * @example "/myapp/stripe/webhook-secret"
   */
  readonly webhookSecretParameterName: string;

  /**
   * Lambda layer that provides the `stripe` Python package for the Python 3.12 runtime.
   * The Lambda runtime does not include it. One way to build it:
   * `pip install stripe -t layer/python && cdk` with `lambda.Code.fromAsset('layer')`.
   */
  readonly stripeLayer: lambda.ILayerVersion;

  /**
   * Authorizer that protects the checkout and portal endpoints, for example
   * `MultiTenantAuth.authorizer`. The webhook endpoint stays public and is verified
   * by its Stripe signature instead.
   */
  readonly authorizer: apigateway.IAuthorizer;

  /**
   * JWT claim that holds the caller's tenant ID. The tenant is never read from the request body.
   * @default "custom:tenant_id"
   */
  readonly tenantIdClaim?: string;

  /**
   * Success URL after successful payment
   */
  readonly successUrl: string;

  /**
   * Cancel URL when payment is cancelled
   */
  readonly cancelUrl: string;

  /**
   * Where the Stripe customer portal sends the user back to
   * @default successUrl
   */
  readonly portalReturnUrl?: string;

  /**
   * Lambda function to invoke when payment is successful
   * This function will receive the Stripe webhook event
   */
  readonly onPaymentSuccess: lambda.IFunction;

  /**
   * DynamoDB table containing tenant information
   * Must have partition key 'tenant_id' and GSI 'stripe-customer-index' on 'stripe_customer_id'
   * (MultiTenantAuth.tenantsTable has both).
   */
  readonly tenantsTable: dynamodb.ITable;

  /**
   * Stripe publishable key (stored as environment variable)
   * @default undefined
   */
  readonly stripePublishableKey?: string;
}

/**
 * Stripe subscription billing for a multi-tenant app: checkout sessions, a signed webhook
 * that updates the tenant's tier, and customer portal sessions.
 *
 * API Endpoints:
 * - POST /billing/checkout - Create checkout session (authorized; tenant from the JWT)
 * - POST /billing/webhook - Process Stripe webhooks (public; Stripe signature verified)
 * - POST /billing/portal - Create customer portal session (authorized; tenant from the JWT)
 *
 * @example
 * ```typescript
 * new StripeBilling(this, 'Billing', {
 *   appName: 'MyApp',
 *   tiers: [{ name: 'Pro', priceId: 'price_9012', amount: 9999 }],
 *   stripeSecretKeyParameterName: '/myapp/stripe/secret-key',
 *   webhookSecretParameterName: '/myapp/stripe/webhook-secret',
 *   stripeLayer,
 *   authorizer: auth.authorizer,
 *   successUrl: 'https://myapp.com/success',
 *   cancelUrl: 'https://myapp.com/cancel',
 *   onPaymentSuccess: paymentHandler,
 *   tenantsTable: auth.tenantsTable,
 * });
 * ```
 */
export class StripeBilling extends Construct {
  /**
   * Lambda function for creating checkout sessions
   */
  public readonly checkoutFunction: lambda.Function;

  /**
   * Lambda function for handling Stripe webhooks
   */
  public readonly webhookFunction: lambda.Function;

  /**
   * Lambda function for creating customer portal sessions
   */
  public readonly portalFunction: lambda.Function;

  /**
   * API Gateway for billing endpoints
   */
  public readonly api: apigateway.RestApi;

  /**
   * SSM parameter for webhook secret
   */
  public readonly webhookSecretParameter: ssm.IStringParameter;

  /**
   * SSM parameter for the Stripe secret API key
   */
  public readonly secretKeyParameter: ssm.IStringParameter;

  constructor(scope: Construct, id: string, props: StripeBillingProps) {
    super(scope, id);

    const {
      appName,
      tiers,
      stripeSecretKeyParameterName,
      webhookSecretParameterName,
      stripeLayer,
      authorizer,
      tenantIdClaim = 'custom:tenant_id',
      successUrl,
      cancelUrl,
      portalReturnUrl = successUrl,
      onPaymentSuccess,
      tenantsTable,
      stripePublishableKey,
    } = props;

    if (tiers.length === 0) {
      throw new Error('StripeBilling needs at least one tier');
    }

    this.secretKeyParameter = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'SecretKey', {
      parameterName: stripeSecretKeyParameterName,
    });
    this.webhookSecretParameter = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'WebhookSecret', {
      parameterName: webhookSecretParameterName,
    });

    const common = {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      layers: [stripeLayer],
    };
    const commonEnv = {
      TENANTS_TABLE_NAME: tenantsTable.tableName,
      STRIPE_KEY_PARAM: stripeSecretKeyParameterName,
      TENANT_CLAIM: tenantIdClaim,
    };

    this.checkoutFunction = new lambda.Function(this, 'CheckoutFunction', {
      ...common,
      functionName: `${appName}-stripe-checkout`,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...commonEnv,
        SUCCESS_URL: successUrl,
        CANCEL_URL: cancelUrl,
        STRIPE_PUBLISHABLE_KEY: stripePublishableKey || '',
        ALLOWED_PRICES: JSON.stringify(tiers.map((t) => t.priceId)),
      },
      code: lambda.Code.fromInline(COMMON_PY + `
def handler(event, context):
    tenant_id = tenant_from(event)
    if not tenant_id:
        return reply(403, {'error': 'no tenant in token'})
    body = json.loads(event.get('body') or '{}')
    price_id = body.get('price_id')
    if price_id not in json.loads(os.environ['ALLOWED_PRICES']):
        return reply(400, {'error': 'unknown price_id'})
    tenant = table.get_item(Key={'tenant_id': tenant_id}).get('Item')
    if not tenant:
        return reply(404, {'error': 'tenant not found'})
    stripe = client()
    customer_id = tenant.get('stripe_customer_id')
    if not customer_id:
        customer_id = stripe.Customer.create(email=tenant.get('email', ''), metadata={'tenant_id': tenant_id}).id
        table.update_item(Key={'tenant_id': tenant_id}, UpdateExpression='SET stripe_customer_id = :c',
                          ExpressionAttributeValues={':c': customer_id})
    session = stripe.checkout.Session.create(
        customer=customer_id, mode='subscription', line_items=[{'price': price_id, 'quantity': 1}],
        success_url=os.environ['SUCCESS_URL'], cancel_url=os.environ['CANCEL_URL'],
        metadata={'tenant_id': tenant_id, 'price_id': price_id})
    return reply(200, {'checkout_url': session.url, 'session_id': session.id})
`),
    });

    this.webhookFunction = new lambda.Function(this, 'WebhookFunction', {
      ...common,
      functionName: `${appName}-stripe-webhook`,
      timeout: cdk.Duration.minutes(1),
      environment: {
        ...commonEnv,
        WEBHOOK_SECRET_PARAM: webhookSecretParameterName,
        PAYMENT_SUCCESS_FUNCTION: onPaymentSuccess.functionName,
        TIERS_CONFIG: JSON.stringify(tiers),
      },
      code: lambda.Code.fromInline(COMMON_PY + `
lambda_client = boto3.client('lambda')
WEBHOOK_SECRET = None


def handler(event, context):
    global WEBHOOK_SECRET
    if WEBHOOK_SECRET is None:
        WEBHOOK_SECRET = param(os.environ['WEBHOOK_SECRET_PARAM'])
    stripe = client()
    headers = {k.lower(): v for k, v in (event.get('headers') or {}).items()}
    try:
        evt = stripe.Webhook.construct_event(event.get('body') or '', headers.get('stripe-signature'), WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError):
        logger.warning('rejected webhook with bad payload or signature')
        return {'statusCode': 400}
    now = datetime.now(timezone.utc).isoformat()

    if evt['type'] == 'checkout.session.completed':
        session = evt['data']['object']
        tenant_id = session['metadata']['tenant_id']
        sub = stripe.Subscription.retrieve(session['subscription'])
        price_id = sub['items']['data'][0]['price']['id']
        tiers = json.loads(os.environ['TIERS_CONFIG'])
        tier = next((t['name'] for t in tiers if t['priceId'] == price_id), 'unknown').lower()
        table.update_item(
            Key={'tenant_id': tenant_id},
            UpdateExpression='SET stripe_customer_id = :c, tier = :t, stripe_subscription_id = :s, updated_at = :u',
            ExpressionAttributeValues={':c': session['customer'], ':t': tier, ':s': sub['id'], ':u': now})
        lambda_client.invoke(FunctionName=os.environ['PAYMENT_SUCCESS_FUNCTION'], InvocationType='Event',
                             Payload=json.dumps({'tenant_id': tenant_id, 'tier': tier, 'stripe_event': evt}))
        logger.info('tenant %s moved to tier %s', tenant_id, tier)

    elif evt['type'] == 'customer.subscription.deleted':
        customer_id = evt['data']['object']['customer']
        items = table.query(IndexName='stripe-customer-index', KeyConditionExpression='stripe_customer_id = :c',
                            ExpressionAttributeValues={':c': customer_id})['Items']
        for item in items:
            table.update_item(Key={'tenant_id': item['tenant_id']},
                              UpdateExpression='SET tier = :t, updated_at = :u REMOVE stripe_subscription_id',
                              ExpressionAttributeValues={':t': 'free', ':u': now})
            logger.info('tenant %s moved to free tier', item['tenant_id'])
    return {'statusCode': 200}
`),
    });

    this.portalFunction = new lambda.Function(this, 'PortalFunction', {
      ...common,
      functionName: `${appName}-stripe-portal`,
      timeout: cdk.Duration.seconds(30),
      environment: {
        ...commonEnv,
        RETURN_URL: portalReturnUrl,
      },
      code: lambda.Code.fromInline(COMMON_PY + `
def handler(event, context):
    tenant_id = tenant_from(event)
    if not tenant_id:
        return reply(403, {'error': 'no tenant in token'})
    tenant = table.get_item(Key={'tenant_id': tenant_id}).get('Item')
    if not tenant or not tenant.get('stripe_customer_id'):
        return reply(404, {'error': 'no Stripe customer for this tenant'})
    session = client().billing_portal.Session.create(
        customer=tenant['stripe_customer_id'], return_url=os.environ['RETURN_URL'])
    return reply(200, {'portal_url': session.url})
`),
    });

    // Permissions
    tenantsTable.grantReadWriteData(this.checkoutFunction);
    tenantsTable.grantReadWriteData(this.webhookFunction);
    tenantsTable.grantReadData(this.portalFunction);
    for (const fn of [this.checkoutFunction, this.webhookFunction, this.portalFunction]) {
      this.secretKeyParameter.grantRead(fn);
    }
    this.webhookSecretParameter.grantRead(this.webhookFunction);
    onPaymentSuccess.grantInvoke(this.webhookFunction);

    // API Gateway
    this.api = new apigateway.RestApi(this, 'BillingAPI', {
      restApiName: `${appName}-billing-api`,
      description: `Stripe billing API for ${appName}`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['POST', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const billing = this.api.root.addResource('billing');
    const authorized: apigateway.MethodOptions = {
      authorizer,
      authorizationType: apigateway.AuthorizationType.COGNITO,
    };
    billing.addResource('checkout').addMethod('POST', new apigateway.LambdaIntegration(this.checkoutFunction), authorized);
    billing.addResource('webhook').addMethod('POST', new apigateway.LambdaIntegration(this.webhookFunction));
    billing.addResource('portal').addMethod('POST', new apigateway.LambdaIntegration(this.portalFunction), authorized);

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'StripeBilling');

    // Output important values
    new cdk.CfnOutput(this, 'BillingApiUrl', {
      value: this.api.url,
      description: 'Base URL for billing API',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-BillingApiUrl`,
    });

    new cdk.CfnOutput(this, 'WebhookEndpoint', {
      value: `${this.api.url}billing/webhook`,
      description: 'Stripe webhook endpoint (register this URL in the Stripe dashboard)',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-WebhookEndpoint`,
    });
  }

  /**
   * Grant permission to invoke checkout function
   * @param grantee The IAM principal to grant permissions to
   */
  public grantCreateCheckout(grantee: iam.IGrantable): iam.Grant {
    return this.checkoutFunction.grantInvoke(grantee);
  }

  /**
   * Grant permission to invoke portal function
   * @param grantee The IAM principal to grant permissions to
   */
  public grantCreatePortalSession(grantee: iam.IGrantable): iam.Grant {
    return this.portalFunction.grantInvoke(grantee);
  }
}

/** Shared Python prelude for the three handlers. */
const COMMON_PY = `
import json
import logging
import os
from datetime import datetime, timezone

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)
table = boto3.resource('dynamodb').Table(os.environ['TENANTS_TABLE_NAME'])
_ssm = boto3.client('ssm')
_stripe = None


def param(name):
    return _ssm.get_parameter(Name=name, WithDecryption=True)['Parameter']['Value']


def client():
    global _stripe
    if _stripe is None:
        import stripe
        stripe.api_key = param(os.environ['STRIPE_KEY_PARAM'])
        _stripe = stripe
    return _stripe


def tenant_from(event):
    claims = ((event.get('requestContext') or {}).get('authorizer') or {}).get('claims') or {}
    return claims.get(os.environ['TENANT_CLAIM'])


def reply(status, body):
    headers = {'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*'}
    return {'statusCode': status, 'headers': headers, 'body': json.dumps(body)}
`;
