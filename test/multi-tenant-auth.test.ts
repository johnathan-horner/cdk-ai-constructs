import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { MultiTenantAuth } from '../src/constructs/multi-tenant-auth';
import { outputIds } from './helpers';

describe('MultiTenantAuth', () => {
  let app: cdk.App;
  let stack: cdk.Stack;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
  });

  test('creates resources without error', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);
    expect(template).toBeDefined();
  });

  test('creates Cognito User Pool with correct configuration', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
      mfaRequired: true,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'TestApp-users',
      AutoVerifiedAttributes: ['email'],
      UsernameAttributes: ['email'],
      MfaConfiguration: 'ON',
      EnabledMfas: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA'],
      Policies: {
        PasswordPolicy: {
          MinimumLength: 8,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
          RequireUppercase: true,
        },
      },
    });
  });

  test('creates User Pool Client with OAuth configuration', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'TestApp-client',
      GenerateSecret: false,
      SupportedIdentityProviders: ['COGNITO'],
      CallbackURLs: ['https://example.com/callback'],
      LogoutURLs: ['https://example.com/callback'],
      AllowedOAuthFlows: ['code'],
      AllowedOAuthScopes: ['openid', 'email', 'profile'],
    });
  });

  test('creates DynamoDB tenants table', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'TestApp-tenants',
      KeySchema: [
        {
          AttributeName: 'tenant_id',
          KeyType: 'HASH',
        },
      ],
      BillingMode: 'PAY_PER_REQUEST',
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    });

    // Check for GSI
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        {
          IndexName: 'stripe-customer-index',
          KeySchema: [
            {
              AttributeName: 'stripe_customer_id',
              KeyType: 'HASH',
            },
          ],
          Projection: {
            ProjectionType: 'ALL',
          },
        },
      ]),
    });
  });

  test('creates post-confirmation Lambda trigger', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'TestApp-post-confirmation',
      Runtime: 'python3.11',
      Handler: 'index.handler',
    });

    // Check that User Pool has the trigger configured
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      LambdaConfig: {
        PostConfirmation: { 'Fn::GetAtt': [Match.stringLikeRegexp('PostConfirmationTrigger'), 'Arn'] },
      },
    });
  });

  test('creates API Gateway authorizer when it is used', () => {
    const auth = new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });
    const api = new apigateway.RestApi(stack, 'Api');
    api.root.addMethod('GET', new apigateway.MockIntegration(), { authorizer: auth.authorizer });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Name: 'TestApp-authorizer',
      Type: 'COGNITO_USER_POOLS',
      IdentitySource: 'method.request.header.Authorization',
    });
  });

  test('includes custom attributes in User Pool', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
      customAttributes: ['company_size', 'industry'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Schema: Match.arrayWith([
        // Standard tenant attributes
        {
          AttributeDataType: 'String',
          Name: 'tenant_id',
          Mutable: true,
        },
        {
          AttributeDataType: 'String',
          Name: 'tier',
          Mutable: true,
        },
        {
          AttributeDataType: 'String',
          Name: 'plan',
          Mutable: true,
        },
        // Custom attributes
        {
          AttributeDataType: 'String',
          Name: 'company_size',
          Mutable: true,
        },
        {
          AttributeDataType: 'String',
          Name: 'industry',
          Mutable: true,
        },
      ]),
    });
  });

  test('creates User Pool Domain when prefix provided', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
      domainPrefix: 'testapp-auth',
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'testapp-auth',
    });
  });

  test('grants proper DynamoDB permissions to Lambda', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);

    // Check that Lambda has DynamoDB write permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['dynamodb:PutItem']),
            Resource: Match.arrayWith([{ 'Fn::GetAtt': [Match.stringLikeRegexp('TenantsTable'), 'Arn'] }]),
          }),
        ]),
      },
    });
  });

  test('creates required CfnOutputs', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
      domainPrefix: 'testapp-auth',
    });

    const template = Template.fromStack(stack);

    expect(outputIds(template).join(' ')).toContain('UserPoolId');
    expect(outputIds(template).join(' ')).toContain('UserPoolClientId');
    expect(outputIds(template).join(' ')).toContain('TenantsTableName');
    expect(outputIds(template).join(' ')).toContain('TenantsTableArn');
    expect(outputIds(template).join(' ')).toContain('UserPoolDomainUrl');
  });

  test('applies correct tags', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolTags: {
        Project: 'TestApp',
        ManagedBy: 'cdk-ai-constructs',
        Component: 'MultiTenantAuth',
      },
    });
  });

  test('does not use wildcard actions in IAM policies', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
    });

    const template = Template.fromStack(stack);

    // Ensure no policies have wildcard actions
    const policies = template.findResources('AWS::IAM::Policy');
    Object.values(policies).forEach((policy: any) => {
      const statements = policy.Properties.PolicyDocument.Statement;
      statements.forEach((statement: any) => {
        if (Array.isArray(statement.Action)) {
          expect(statement.Action).not.toContain('*');
        } else if (typeof statement.Action === 'string') {
          expect(statement.Action).not.toBe('*');
        }
      });
    });
  });

  test('configures password policy correctly', () => {
    new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: false,
          RequireUppercase: true,
        },
      },
    });
  });

  describe('tenant isolation fixes in 2.0.0', () => {
    const build = () => new MultiTenantAuth(stack, 'TestAuth', {
      appName: 'TestApp',
      callbackUrls: ['https://example.com/callback'],
      customAttributes: ['company_size'],
    });

    test('the app client cannot write tenant_id, tier or plan', () => {
      build();
      const client = Object.values(Template.fromStack(stack).findResources('AWS::Cognito::UserPoolClient'))[0] as any;
      const write: string[] = client.Properties.WriteAttributes;
      expect(write).toEqual(expect.arrayContaining(['email', 'custom:company_size']));
      for (const attr of ['custom:tenant_id', 'custom:tier', 'custom:plan']) {
        expect(write).not.toContain(attr);
        expect(client.Properties.ReadAttributes).toContain(attr);
      }
    });

    test('the trigger may write the tenant ID back to the user', () => {
      build();
      Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: 'cognito-idp:AdminUpdateUserAttributes', Effect: 'Allow' }),
          ]),
        },
      });
    });

    test('the trigger never overwrites a tenant, never writes a null index key, never logs the event', () => {
      build();
      const fns = Template.fromStack(stack).findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'TestApp-post-confirmation' },
      });
      const code: string = (Object.values(fns)[0] as any).Properties.Code.ZipFile;
      expect(code).toContain("ConditionExpression='attribute_not_exists(tenant_id)'");
      expect(code).not.toContain("'stripe_customer_id': None");
      expect(code).not.toContain('json.dumps(event)');
    });

    test('no authorizer is created when nothing uses it', () => {
      build();
      Template.fromStack(stack).resourceCountIs('AWS::ApiGateway::Authorizer', 0);
    });
  });
});
