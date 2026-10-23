import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Route configuration for API Gateway
 */
export interface ApiRoute {
  /**
   * HTTP method
   */
  readonly method: string;

  /**
   * Resource path (can include path parameters like '/users/{id}')
   */
  readonly path: string;

  /**
   * Lambda function to handle this route
   */
  readonly handler: lambda.Function;

  /**
   * Whether this route requires authentication
   * @default true if cognitoAuthorizer is provided in construct props
   */
  readonly requiresAuth?: boolean;

  /**
   * Request validation settings
   * @default undefined
   */
  readonly requestValidation?: {
    validateBody?: boolean;
    validateParameters?: boolean;
  };
}

/**
 * Throttling configuration
 */
export interface ThrottleConfig {
  /**
   * Requests per second limit
   */
  readonly rateLimit: number;

  /**
   * Burst limit for temporary spikes
   */
  readonly burstLimit: number;
}

/**
 * Properties for APIGatewayLambda construct
 */
export interface APIGatewayLambdaProps {
  /**
   * Name for the API Gateway
   */
  readonly apiName: string;

  /**
   * Array of routes to create
   */
  readonly routes: ApiRoute[];

  /**
   * Cognito User Pool for authorization
   * If provided, creates a Cognito authorizer
   * @default undefined
   */
  readonly cognitoAuthorizer?: cognito.UserPool;

  /**
   * CORS allowed origins. Credentials (cookies, Authorization headers) are only allowed
   * when specific origins are listed, because browsers reject credentials with `*`.
   * @default ['*']
   */
  readonly corsOrigins?: string[];

  /**
   * Throttling configuration
   * If provided, creates usage plan with API key
   * @default undefined
   */
  readonly throttle?: ThrottleConfig;

  /**
   * Application name for consistent tagging and naming
   */
  readonly appName: string;

  /**
   * Enable CloudWatch access logging and INFO-level execution logging.
   * API Gateway needs an account-level CloudWatch role for this, which the construct
   * creates (one `AWS::ApiGateway::Account` resource per account and region).
   * @default true
   */
  readonly enableAccessLogs?: boolean;

  /**
   * CloudWatch log retention period in days. Must be a value CloudWatch Logs accepts.
   * @default 30
   */
  readonly logRetentionDays?: number;

  /**
   * Deploy to a specific stage name
   * @default 'prod'
   */
  readonly stageName?: string;

}

/**
 * A construct that creates an API Gateway REST API with Lambda integrations,
 * optional Cognito authorization, CORS support, throttling, and monitoring.
 *
 * Features:
 * - REST API with configurable routes and methods
 * - Lambda function integrations with proper permissions
 * - Optional Cognito User Pool authorization
 * - CORS configuration for web clients
 * - Request throttling with usage plans
 * - CloudWatch access logging and monitoring
 * - Error handling with proper HTTP status codes
 *
 * @example
 * ```typescript
 * const getUsersFunction = new lambda.Function(this, 'GetUsers', {
 *   runtime: lambda.Runtime.PYTHON_3_11,
 *   handler: 'index.get_users',
 *   code: lambda.Code.fromAsset('lambda'),
 * });
 *
 * const createUserFunction = new lambda.Function(this, 'CreateUser', {
 *   runtime: lambda.Runtime.PYTHON_3_11,
 *   handler: 'index.create_user',
 *   code: lambda.Code.fromAsset('lambda'),
 * });
 *
 * new APIGatewayLambda(this, 'API', {
 *   appName: 'MyApp',
 *   apiName: 'user-management-api',
 *   routes: [
 *     { method: 'GET', path: '/users', handler: getUsersFunction },
 *     { method: 'POST', path: '/users', handler: createUserFunction },
 *     { method: 'GET', path: '/users/{id}', handler: getUserFunction }
 *   ],
 *   cognitoAuthorizer: userPool,
 *   corsOrigins: ['https://myapp.com'],
 *   throttle: { rateLimit: 100, burstLimit: 200 }
 * });
 * ```
 */
export class APIGatewayLambda extends Construct {
  /**
   * The API Gateway REST API
   */
  public readonly api: apigateway.RestApi;

  /**
   * Cognito authorizer (if created)
   */
  public readonly authorizer?: apigateway.CognitoUserPoolsAuthorizer;

  /**
   * Usage plan for throttling (if created)
   */
  public readonly usagePlan?: apigateway.UsagePlan;

  /**
   * API key for usage plan (if created)
   */
  public readonly apiKey?: apigateway.ApiKey;

  /**
   * CloudWatch log group for API access logs
   */
  public readonly accessLogGroup?: logs.LogGroup;

  /**
   * Map of created resources for programmatic access
   */
  public readonly resources: Map<string, apigateway.Resource> = new Map();

  constructor(scope: Construct, id: string, props: APIGatewayLambdaProps) {
    super(scope, id);

    const {
      apiName,
      routes,
      cognitoAuthorizer,
      corsOrigins = ['*'],
      throttle,
      appName,
      enableAccessLogs = true,
      logRetentionDays = 30,
      stageName = 'prod',
    } = props;

    // Create CloudWatch log group for access logs
    if (enableAccessLogs) {
      this.accessLogGroup = new logs.LogGroup(this, 'AccessLogGroup', {
        logGroupName: `/aws/apigateway/${apiName}`,
        retention: toRetention(logRetentionDays),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // Create API Gateway
    const allowsAnyOrigin = corsOrigins.includes('*');
    this.api = new apigateway.RestApi(this, 'API', {
      restApiName: apiName,
      description: `REST API for ${appName}`,
      // Logging needs the account-level API Gateway CloudWatch role.
      cloudWatchRole: enableAccessLogs,
      defaultCorsPreflightOptions: {
        allowOrigins: corsOrigins,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: [
          'Content-Type',
          'Authorization',
          'X-Amz-Date',
          'X-Api-Key',
          'X-Amz-Security-Token',
        ],
        allowCredentials: !allowsAnyOrigin,
      },
      deployOptions: {
        stageName: stageName,
        accessLogDestination: this.accessLogGroup
          ? new apigateway.LogGroupLogDestination(this.accessLogGroup)
          : undefined,
        accessLogFormat: this.accessLogGroup ? apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }) : undefined,
        loggingLevel: enableAccessLogs ? apigateway.MethodLoggingLevel.INFO : apigateway.MethodLoggingLevel.OFF,
        dataTraceEnabled: false,
        metricsEnabled: true,
        throttlingRateLimit: throttle?.rateLimit,
        throttlingBurstLimit: throttle?.burstLimit,
      },
      endpointConfiguration: {
        types: [apigateway.EndpointType.REGIONAL],
      },
    });

    // Create Cognito authorizer if provided
    if (cognitoAuthorizer) {
      this.authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
        cognitoUserPools: [cognitoAuthorizer],
        authorizerName: `${apiName}-authorizer`,
        identitySource: 'method.request.header.Authorization',
      });
    }

    // Create resources and methods
    this.createRoutesAndMethods(routes);

    // Create usage plan and API key if throttling is enabled
    if (throttle) {
      this.usagePlan = new apigateway.UsagePlan(this, 'UsagePlan', {
        name: `${apiName}-usage-plan`,
        description: `Usage plan for ${apiName}`,
        throttle: {
          rateLimit: throttle.rateLimit,
          burstLimit: throttle.burstLimit,
        },
        apiStages: [
          {
            api: this.api,
            stage: this.api.deploymentStage,
          },
        ],
      });

      this.apiKey = new apigateway.ApiKey(this, 'ApiKey', {
        apiKeyName: `${apiName}-key`,
        description: `API key for ${apiName}`,
      });

      this.usagePlan.addApiKey(this.apiKey);
    }

    // Create monitoring
    this.createMonitoring(appName);

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'APIGateway');

    // Output important values
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.url,
      description: 'API Gateway endpoint URL',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ApiUrl`,
    });

    new cdk.CfnOutput(this, 'ApiId', {
      value: this.api.restApiId,
      description: 'API Gateway REST API ID',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ApiId`,
    });

    if (this.apiKey) {
      new cdk.CfnOutput(this, 'ApiKeyId', {
        value: this.apiKey.keyId,
        description: 'API Key ID for throttled requests',
        exportName: `${cdk.Stack.of(this).stackName}-${id}-ApiKeyId`,
      });
    }

    if (this.accessLogGroup) {
      new cdk.CfnOutput(this, 'AccessLogGroupName', {
        value: this.accessLogGroup.logGroupName,
        description: 'CloudWatch log group for API access logs',
        exportName: `${cdk.Stack.of(this).stackName}-${id}-AccessLogGroupName`,
      });
    }

    new cdk.CfnOutput(this, 'RoutesSummary', {
      value: JSON.stringify(
        routes.map(route => ({
          method: route.method,
          path: route.path,
          function: route.handler.functionName,
        }))
      ),
      description: 'Summary of API routes and their handlers',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-RoutesSummary`,
    });
  }

  /**
   * Create API Gateway resources and methods for all routes
   */
  private createRoutesAndMethods(routes: ApiRoute[]): void {
    routes.forEach(route => this.addRouteMethod(route));
  }

  /**
   * Add one method. A route that asks for auth when there is no authorizer is an error,
   * not a silently public endpoint.
   */
  private addRouteMethod(route: ApiRoute): void {
    const resource = this.createResourceFromPath(route.path);
    this.resources.set(route.path, resource);

    const integration = new apigateway.LambdaIntegration(route.handler, {
      proxy: true,
      allowTestInvoke: false,
    });

    const requiresAuth = route.requiresAuth ?? this.authorizer !== undefined;
    if (requiresAuth && !this.authorizer) {
      throw new Error(`Route ${route.method} ${route.path} sets requiresAuth but no cognitoAuthorizer was provided`);
    }

    resource.addMethod(route.method, integration, {
      operationName: `${route.method}${route.path.replace(/[{}]/g, '').replace(/\//g, '_')}`,
      ...(requiresAuth ? { authorizer: this.authorizer, authorizationType: apigateway.AuthorizationType.COGNITO } : {}),
      ...(route.requestValidation ? { requestValidator: this.validatorFor(route.requestValidation) } : {}),
    });
  }

  /**
   * Create API Gateway resource from path
   */
  private createResourceFromPath(path: string): apigateway.Resource {
    const segments = path.split('/').filter(segment => segment.length > 0);
    let currentResource: apigateway.IResource = this.api.root;

    for (const segment of segments) {
      const existingResource = currentResource.getResource(segment);
      if (existingResource) {
        currentResource = existingResource;
      } else {
        currentResource = (currentResource as apigateway.Resource).addResource(segment);
      }
    }

    return currentResource as apigateway.Resource;
  }

  /**
   * Create CloudWatch monitoring for the API
   */
  private createMonitoring(appName: string): void {
    // Create alarm for 4XX errors
    new cloudwatch.Alarm(this, '4XXErrorAlarm', {
      alarmName: `${appName}-api-4xx-errors`,
      alarmDescription: `Monitor 4XX errors in ${appName} API Gateway`,
      metric: this.api.metricClientError({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Create alarm for 5XX errors
    new cloudwatch.Alarm(this, '5XXErrorAlarm', {
      alarmName: `${appName}-api-5xx-errors`,
      alarmDescription: `Monitor 5XX errors in ${appName} API Gateway`,
      metric: this.api.metricServerError({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Create alarm for high latency
    new cloudwatch.Alarm(this, 'LatencyAlarm', {
      alarmName: `${appName}-api-high-latency`,
      alarmDescription: `Monitor high latency in ${appName} API Gateway`,
      metric: this.api.metricLatency({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 5000, // 5 seconds
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * Add a new route to the API
   * @param route The route configuration to add
   */
  public addRoute(route: ApiRoute): void {
    this.addRouteMethod(route);
  }

  private readonly validators = new Map<string, apigateway.RequestValidator>();

  private validatorFor(opts: { validateBody?: boolean; validateParameters?: boolean }): apigateway.RequestValidator {
    const key = `${!!opts.validateBody}-${!!opts.validateParameters}`;
    let validator = this.validators.get(key);
    if (!validator) {
      validator = new apigateway.RequestValidator(this, `Validator-${key}`, {
        restApi: this.api,
        validateRequestBody: !!opts.validateBody,
        validateRequestParameters: !!opts.validateParameters,
      });
      this.validators.set(key, validator);
    }
    return validator;
  }

  /**
   * Get a resource by path
   * @param path The resource path
   * @returns The API Gateway resource
   */
  public getResource(path: string): apigateway.Resource | undefined {
    return this.resources.get(path);
  }
}

function toRetention(days: number): logs.RetentionDays {
  const valid = Object.values(logs.RetentionDays).filter((v) => typeof v === 'number') as number[];
  if (!valid.includes(days)) {
    throw new Error(`logRetentionDays ${days} is not a CloudWatch Logs retention value (${valid.join(', ')})`);
  }
  return days as logs.RetentionDays;
}
