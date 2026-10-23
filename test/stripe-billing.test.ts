import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MultiTenantAuth } from '../src/constructs/multi-tenant-auth';
import { StripeBilling, StripeBillingProps } from '../src/constructs/stripe-billing';

describe('StripeBilling', () => {
  let stack: cdk.Stack;
  let auth: MultiTenantAuth;
  let props: StripeBillingProps;

  beforeEach(() => {
    stack = new cdk.Stack(new cdk.App(), 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
    auth = new MultiTenantAuth(stack, 'Auth', { appName: 'TestApp', callbackUrls: ['https://app.example.com/cb'] });
    props = {
      appName: 'TestApp',
      tiers: [
        { name: 'Starter', priceId: 'price_starter', amount: 999 },
        { name: 'Pro', priceId: 'price_pro', amount: 9999 },
      ],
      stripeSecretKeyParameterName: '/testapp/stripe/secret-key',
      webhookSecretParameterName: '/testapp/stripe/webhook-secret',
      stripeLayer: lambda.LayerVersion.fromLayerVersionArn(stack, 'Layer', 'arn:aws:lambda:us-east-1:123456789012:layer:stripe:3'),
      authorizer: auth.authorizer,
      successUrl: 'https://app.example.com/billing/ok',
      cancelUrl: 'https://app.example.com/billing/cancel',
      onPaymentSuccess: new lambda.Function(stack, 'OnPaid', {
        runtime: lambda.Runtime.PYTHON_3_12, handler: 'index.handler', code: lambda.Code.fromInline('x = 1'),
      }),
      tenantsTable: auth.tenantsTable,
    };
  });

  function fnByName(template: Template, name: string): any {
    return Object.values(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: name } }))[0];
  }

  test('protects checkout and portal with the authorizer and leaves the webhook public', () => {
    new StripeBilling(stack, 'Billing', props);
    const template = Template.fromStack(stack);
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method')) as any[];
    const posts = methods.filter((m) => m.Properties.HttpMethod === 'POST');
    expect(posts).toHaveLength(3);
    const authTypes = posts.map((m) => m.Properties.AuthorizationType).sort();
    expect(authTypes).toEqual(['COGNITO_USER_POOLS', 'COGNITO_USER_POOLS', 'NONE']);
    expect(methods.some((m) => m.Properties.HttpMethod === 'GET')).toBe(false);
  });

  test('every function gets the stripe layer and the Python 3.12 runtime', () => {
    new StripeBilling(stack, 'Billing', props);
    const template = Template.fromStack(stack);
    for (const name of ['TestApp-stripe-checkout', 'TestApp-stripe-webhook', 'TestApp-stripe-portal']) {
      const fn = fnByName(template, name);
      expect(fn.Properties.Layers).toEqual(['arn:aws:lambda:us-east-1:123456789012:layer:stripe:3']);
      expect(fn.Properties.Runtime).toBe('python3.12');
    }
  });

  test('reads the tenant from the JWT claim, never from the request body', () => {
    new StripeBilling(stack, 'Billing', { ...props, tenantIdClaim: 'custom:org' });
    const template = Template.fromStack(stack);
    for (const name of ['TestApp-stripe-checkout', 'TestApp-stripe-portal']) {
      const fn = fnByName(template, name);
      expect(fn.Properties.Environment.Variables.TENANT_CLAIM).toBe('custom:org');
      const code: string = fn.Properties.Code.ZipFile;
      expect(code).toContain('tenant_id = tenant_from(event)');
      expect(code).not.toContain("body.get('tenant_id')");
    }
  });

  test('checkout only accepts configured price IDs', () => {
    new StripeBilling(stack, 'Billing', props);
    const fn = fnByName(Template.fromStack(stack), 'TestApp-stripe-checkout');
    expect(JSON.parse(fn.Properties.Environment.Variables.ALLOWED_PRICES)).toEqual(['price_starter', 'price_pro']);
    expect(fn.Properties.Code.ZipFile).toContain("price_id not in json.loads(os.environ['ALLOWED_PRICES'])");
  });

  test('portal return URL is fixed by the deployer, not taken from the request', () => {
    new StripeBilling(stack, 'Billing', { ...props, portalReturnUrl: 'https://app.example.com/account' });
    const fn = fnByName(Template.fromStack(stack), 'TestApp-stripe-portal');
    expect(fn.Properties.Environment.Variables.RETURN_URL).toBe('https://app.example.com/account');
    expect(fn.Properties.Code.ZipFile).not.toContain('return_url = body');
  });

  test('webhook reads the Stripe-Signature header case-insensitively', () => {
    new StripeBilling(stack, 'Billing', props);
    const code: string = fnByName(Template.fromStack(stack), 'TestApp-stripe-webhook').Properties.Code.ZipFile;
    expect(code).toContain('{k.lower(): v for k, v in');
    expect(code).toContain("headers.get('stripe-signature')");
  });

  test('stores only parameter names in the template, never secret values', () => {
    new StripeBilling(stack, 'Billing', props);
    const template = Template.fromStack(stack);
    const webhook = fnByName(template, 'TestApp-stripe-webhook');
    expect(webhook.Properties.Environment.Variables.WEBHOOK_SECRET_PARAM).toBe('/testapp/stripe/webhook-secret');
    expect(webhook.Properties.Environment.Variables.STRIPE_KEY_PARAM).toBe('/testapp/stripe/secret-key');
    expect(JSON.stringify(template.toJSON())).not.toMatch(/sk_(live|test)_|whsec_/);
  });

  test('grants SSM read on both parameters to the webhook', () => {
    new StripeBilling(stack, 'Billing', props);
    const json = JSON.stringify(Template.fromStack(stack).findResources('AWS::IAM::Policy'));
    expect(json).toContain('parameter/testapp/stripe/secret-key');
    expect(json).toContain('parameter/testapp/stripe/webhook-secret');
  });

  test('webhook may invoke the payment success function', () => {
    new StripeBilling(stack, 'Billing', props);
    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({ Action: 'lambda:InvokeFunction' })]),
      },
    });
  });

  test('requires at least one tier', () => {
    expect(() => new StripeBilling(stack, 'Billing', { ...props, tiers: [] })).toThrow(/at least one tier/);
  });
});
