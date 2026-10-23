import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { APIGatewayLambda } from '../src/constructs/api-gateway-lambda';
import { outputIds } from './helpers';

describe('APIGatewayLambda', () => {
  let app: cdk.App;
  let stack: cdk.Stack;
  let testFunction: lambda.Function;
  let userPool: cognito.UserPool;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });

    testFunction = new lambda.Function(stack, 'TestFunction', {
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context): pass'),
    });

    userPool = new cognito.UserPool(stack, 'TestUserPool', {
      userPoolName: 'test-pool',
    });
  });

  test('creates resources without error', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
    });

    const template = Template.fromStack(stack);
    expect(template).toBeDefined();
  });

  test('creates API Gateway with correct configuration', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
      stageName: 'prod',
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: 'test-api',
      Description: 'REST API for TestApp',
    });

    template.hasResourceProperties('AWS::ApiGateway::Stage', {
      StageName: 'prod',
    });
  });

  test('creates resources and methods for routes', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/users',
          handler: testFunction,
        },
        {
          method: 'POST',
          path: '/users',
          handler: testFunction,
        },
        {
          method: 'GET',
          path: '/users/{id}',
          handler: testFunction,
        },
      ],
    });

    const template = Template.fromStack(stack);

    // Should create resources
    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: 'users',
    });

    template.hasResourceProperties('AWS::ApiGateway::Resource', {
      PathPart: '{id}',
    });

    // Should create methods
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
    });

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'POST',
    });
  });

  test('creates Cognito authorizer when user pool provided', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/protected',
          handler: testFunction,
        },
      ],
      cognitoAuthorizer: userPool,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ApiGateway::Authorizer', {
      Name: 'test-api-authorizer',
      Type: 'COGNITO_USER_POOLS',
      IdentitySource: 'method.request.header.Authorization',
    });
  });

  test('creates Lambda integrations', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'GET',
      Integration: Match.objectLike({
        Type: 'AWS_PROXY',
        IntegrationHttpMethod: 'POST',
      }),
    });
  });

  test('grants Lambda invoke permissions', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Lambda::Permission', {
      Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com',
    });
  });

  test('creates usage plan and API key when throttle configured', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::ApiGateway::UsagePlan', {
      UsagePlanName: 'test-api-usage-plan',
      Throttle: {
        RateLimit: 100,
        BurstLimit: 200,
      },
    });

    template.hasResourceProperties('AWS::ApiGateway::ApiKey', {
      Name: 'test-api-key',
    });
  });

  test('configures CORS correctly', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
      corsOrigins: ['https://example.com', 'https://app.example.com'],
    });

    const template = Template.fromStack(stack);

    // Should create OPTIONS method for CORS
    template.hasResourceProperties('AWS::ApiGateway::Method', {
      HttpMethod: 'OPTIONS',
    });
  });

  test('creates CloudWatch monitoring', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
    });

    const template = Template.fromStack(stack);

    // Should create alarms for monitoring
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TestApp-api-4xx-errors',
      MetricName: '4XXError',
      Namespace: 'AWS/ApiGateway',
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TestApp-api-5xx-errors',
      MetricName: '5XXError',
      Namespace: 'AWS/ApiGateway',
    });

    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'TestApp-api-high-latency',
      MetricName: 'Latency',
      Namespace: 'AWS/ApiGateway',
    });
  });

  test('creates access logging when enabled', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
      enableAccessLogs: true,
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/apigateway/test-api',
    });
  });

  test('creates required CfnOutputs', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
      throttle: {
        rateLimit: 100,
        burstLimit: 200,
      },
    });

    const template = Template.fromStack(stack);

    expect(outputIds(template).join(' ')).toContain('ApiUrl');
    expect(outputIds(template).join(' ')).toContain('ApiId');
    expect(outputIds(template).join(' ')).toContain('ApiKeyId');
    expect(outputIds(template).join(' ')).toContain('RoutesSummary');
  });

  test('applies correct tags', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/test',
          handler: testFunction,
        },
      ],
    });

    const template = Template.fromStack(stack);

    // Check that resources have required tags
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Tags: Match.arrayWith([
        { Key: 'Component', Value: 'APIGateway' },
        { Key: 'ManagedBy', Value: 'cdk-ai-constructs' },
        { Key: 'Project', Value: 'TestApp' },
      ]),
    });
  });

  test('handles authorization correctly', () => {
    new APIGatewayLambda(stack, 'TestAPI', {
      appName: 'TestApp',
      apiName: 'test-api',
      routes: [
        {
          method: 'GET',
          path: '/public',
          handler: testFunction,
          requiresAuth: false,
        },
        {
          method: 'GET',
          path: '/protected',
          handler: testFunction,
          requiresAuth: true,
        },
      ],
      cognitoAuthorizer: userPool,
    });

    const template = Template.fromStack(stack);

    // Should have both authorized and non-authorized methods
    const methods = template.findResources('AWS::ApiGateway::Method');
    const nonOptionsMethods = Object.values(methods).filter(
      (method: any) => method.Properties.HttpMethod !== 'OPTIONS'
    );

    expect(nonOptionsMethods.length).toBeGreaterThanOrEqual(2);
  });

  /** Values of Access-Control-Allow-Credentials across all CORS preflight methods. */
  function corsCredentialsHeaders(template: Template): string[] {
    const methods = template.findResources('AWS::ApiGateway::Method', { Properties: { HttpMethod: 'OPTIONS' } });
    return Object.values(methods).flatMap((m: any) =>
      (m.Properties.Integration.IntegrationResponses ?? [])
        .map((r: any) => r.ResponseParameters?.['method.response.header.Access-Control-Allow-Credentials'])
        .filter((v: unknown) => v !== undefined));
  }

  describe('fixes in 2.0.0', () => {
    const route = () => ({ method: 'GET', path: '/items', handler: testFunction });

    test('sets up the API Gateway CloudWatch role when logging is on', () => {
      new APIGatewayLambda(stack, 'TestAPI', { appName: 'TestApp', apiName: 'test-api', routes: [route()] });
      Template.fromStack(stack).resourceCountIs('AWS::ApiGateway::Account', 1);
    });

    test('creates no logging resources when logging is off', () => {
      new APIGatewayLambda(stack, 'TestAPI', {
        appName: 'TestApp', apiName: 'test-api', routes: [route()], enableAccessLogs: false,
      });
      const template = Template.fromStack(stack);
      template.resourceCountIs('AWS::ApiGateway::Account', 0);
      template.resourceCountIs('AWS::Logs::LogGroup', 0);
    });

    test('does not allow credentials with a wildcard origin', () => {
      new APIGatewayLambda(stack, 'TestAPI', { appName: 'TestApp', apiName: 'test-api', routes: [route()] });
      expect(corsCredentialsHeaders(Template.fromStack(stack))).toEqual([]);
    });

    test('allows credentials when specific origins are listed', () => {
      new APIGatewayLambda(stack, 'TestAPI', {
        appName: 'TestApp', apiName: 'test-api', routes: [route()], corsOrigins: ['https://app.example.com'],
      });
      const values = corsCredentialsHeaders(Template.fromStack(stack));
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values)).toEqual(new Set(["'true'"]));
    });

    test('refuses a route that requires auth when there is no authorizer', () => {
      expect(() => new APIGatewayLambda(stack, 'TestAPI', {
        appName: 'TestApp', apiName: 'test-api', routes: [{ ...route(), requiresAuth: true }],
      })).toThrow(/requiresAuth but no cognitoAuthorizer/);
    });

    test('lets a route opt out of auth when an authorizer exists', () => {
      new APIGatewayLambda(stack, 'TestAPI', {
        appName: 'TestApp', apiName: 'test-api', cognitoAuthorizer: userPool,
        routes: [{ ...route(), path: '/health', requiresAuth: false }, { ...route(), path: '/private' }],
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'GET', AuthorizationType: 'NONE' });
      template.hasResourceProperties('AWS::ApiGateway::Method', { HttpMethod: 'GET', AuthorizationType: 'COGNITO_USER_POOLS' });
    });

    test('requestValidation creates and attaches a validator', () => {
      new APIGatewayLambda(stack, 'TestAPI', {
        appName: 'TestApp', apiName: 'test-api',
        routes: [{ method: 'POST', path: '/items', handler: testFunction, requestValidation: { validateBody: true } }],
      });
      const template = Template.fromStack(stack);
      template.hasResourceProperties('AWS::ApiGateway::RequestValidator', { ValidateRequestBody: true });
      template.hasResourceProperties('AWS::ApiGateway::Method', {
        HttpMethod: 'POST', RequestValidatorId: Match.anyValue(),
      });
    });

    test('addRoute applies the same rules as constructor routes', () => {
      const api = new APIGatewayLambda(stack, 'TestAPI', { appName: 'TestApp', apiName: 'test-api', routes: [route()] });
      expect(() => api.addRoute({ method: 'DELETE', path: '/items/{id}', handler: testFunction, requiresAuth: true }))
        .toThrow(/requiresAuth/);
    });

    test('rejects an unsupported log retention value', () => {
      expect(() => new APIGatewayLambda(stack, 'TestAPI', {
        appName: 'TestApp', apiName: 'test-api', routes: [route()], logRetentionDays: 10,
      })).toThrow(/not a CloudWatch Logs retention value/);
    });
  });
});
