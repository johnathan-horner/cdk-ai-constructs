import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Properties for MultiTenantAuth construct
 */
export interface MultiTenantAuthProps {
  /**
   * Application name used for naming resources
   */
  readonly appName: string;

  /**
   * Callback URLs for successful authentication
   * @example ['https://myapp.com/callback', 'http://localhost:3000/callback']
   */
  readonly callbackUrls: string[];

  /**
   * Logout URLs for successful sign out
   * @default Same as callbackUrls
   */
  readonly logoutUrls?: string[];

  /**
   * Custom user attributes to add to the user pool
   * tenant_id, tier, and plan are always included
   * @default []
   */
  readonly customAttributes?: string[];

  /**
   * Whether to require multi-factor authentication
   * @default false
   */
  readonly mfaRequired?: boolean;

  /**
   * Password policy settings
   * @default Secure defaults (min 8 chars, requires uppercase, lowercase, number, symbol)
   */
  readonly passwordPolicy?: cognito.PasswordPolicy;

  /**
   * Domain prefix for the Cognito hosted UI
   * If not provided, no hosted UI domain will be created
   * @default undefined
   */
  readonly domainPrefix?: string;
}

/**
 * A comprehensive multi-tenant authentication construct using Amazon Cognito
 * with DynamoDB for tenant management and Lambda triggers for user lifecycle.
 *
 * Features:
 * - Cognito User Pool with custom tenant attributes
 * - DynamoDB table for tenant metadata and billing integration
 * - Lambda trigger for automatic tenant record creation
 * - API Gateway Cognito authorizer for protecting APIs
 * - Support for Stripe integration via tenant metadata
 * - Configurable MFA and password policies
 * - Optional hosted UI with custom domain
 *
 * @example
 * ```typescript
 * const auth = new MultiTenantAuth(this, 'Auth', {
 *   appName: 'MyApp',
 *   callbackUrls: ['https://myapp.com/dashboard'],
 *   customAttributes: ['company_size', 'industry'],
 *   mfaRequired: true,
 *   domainPrefix: 'myapp-auth'
 * });
 *
 * // Use the authorizer in API Gateway
 * const api = new apigateway.RestApi(this, 'API');
 * const protectedResource = api.root.addResource('protected');
 * protectedResource.addMethod('GET', integration, {
 *   authorizer: auth.authorizer
 * });
 * ```
 */
export class MultiTenantAuth extends Construct {
  /**
   * Cognito User Pool for authentication
   */
  public readonly userPool: cognito.UserPool;

  /**
   * Cognito User Pool Client for applications
   */
  public readonly userPoolClient: cognito.UserPoolClient;

  /**
   * DynamoDB table for tenant metadata
   */
  public readonly tenantsTable: dynamodb.Table;

  /**
   * Lambda function for post-confirmation processing
   */
  public readonly postConfirmationTrigger: lambda.Function;

  private _authorizer?: apigateway.CognitoUserPoolsAuthorizer;

  /**
   * Cognito User Pool Domain (if domainPrefix provided)
   */
  public readonly userPoolDomain?: cognito.UserPoolDomain;

  private readonly appName: string;

  /**
   * API Gateway Cognito authorizer for this user pool.
   * Created on first access, because API Gateway rejects an authorizer that is not
   * attached to at least one method.
   */
  public get authorizer(): apigateway.CognitoUserPoolsAuthorizer {
    if (!this._authorizer) {
      this._authorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'Authorizer', {
        cognitoUserPools: [this.userPool],
        authorizerName: `${this.appName}-authorizer`,
        identitySource: 'method.request.header.Authorization',
      });
    }
    return this._authorizer;
  }

  constructor(scope: Construct, id: string, props: MultiTenantAuthProps) {
    super(scope, id);

    const {
      appName,
      callbackUrls,
      logoutUrls = callbackUrls,
      customAttributes = [],
      mfaRequired = false,
      passwordPolicy,
      domainPrefix,
    } = props;

    // Create DynamoDB table for tenants
    this.tenantsTable = new dynamodb.Table(this, 'TenantsTable', {
      tableName: `${appName}-tenants`,
      partitionKey: {
        name: 'tenant_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    });

    // Add GSI for Stripe customer lookups
    this.tenantsTable.addGlobalSecondaryIndex({
      indexName: 'stripe-customer-index',
      partitionKey: {
        name: 'stripe_customer_id',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // Create post-confirmation Lambda trigger
    this.postConfirmationTrigger = new lambda.Function(this, 'PostConfirmationTrigger', {
      functionName: `${appName}-post-confirmation`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import os
import uuid
import logging
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

table = boto3.resource('dynamodb').Table(os.environ['TENANTS_TABLE_NAME'])
cognito = boto3.client('cognito-idp')

RESERVED = {'custom:tenant_id', 'custom:tier', 'custom:plan'}


def handler(event, context):
    attrs = event['request']['userAttributes']
    user_id = event['userName']
    # The app client cannot write custom:tenant_id, so a value here can only come from an
    # administrator (AdminCreateUser). Otherwise this user starts a new tenant.
    tenant_id = attrs.get('custom:tenant_id') or str(uuid.uuid4())

    record = {
        'tenant_id': tenant_id,
        'owner_user_id': user_id,
        'email': attrs.get('email', ''),
        'tier': attrs.get('custom:tier', 'free'),
        'plan': attrs.get('custom:plan', 'starter'),
        'created_at': datetime.now(timezone.utc).isoformat(),
        'knowledge_base_s3_path': f"tenants/{tenant_id}/knowledge-base/",
        'status': 'active',
    }
    for name, value in attrs.items():
        if name.startswith('custom:') and name not in RESERVED:
            record[name.replace('custom:', '')] = value

    try:
        # Never overwrite an existing tenant (a second user joining the same tenant).
        table.put_item(Item=record, ConditionExpression='attribute_not_exists(tenant_id)')
        logger.info('created tenant %s', tenant_id)
    except ClientError as err:
        if err.response['Error']['Code'] != 'ConditionalCheckFailedException':
            raise
        logger.info('tenant %s already exists; user joins it', tenant_id)

    if 'custom:tenant_id' not in attrs:
        cognito.admin_update_user_attributes(
            UserPoolId=event['userPoolId'],
            Username=user_id,
            UserAttributes=[{'Name': 'custom:tenant_id', 'Value': tenant_id}],
        )
    return event
`),
      environment: {
        TENANTS_TABLE_NAME: this.tenantsTable.tableName,
      },
      timeout: cdk.Duration.minutes(1),
    });

    // Grant DynamoDB permissions to the trigger
    this.tenantsTable.grantWriteData(this.postConfirmationTrigger);

    // The trigger writes custom:tenant_id back to the user. The pool ARN cannot be referenced
    // here without a dependency cycle (pool -> trigger -> pool), so the grant covers user pools
    // in this account and region.
    this.postConfirmationTrigger.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cognito-idp:AdminUpdateUserAttributes'],
      resources: [cdk.Stack.of(this).formatArn({
        service: 'cognito-idp', resource: 'userpool', resourceName: '*',
      })],
    }));

    // Build user pool attributes
    const userPoolAttributes: { [key: string]: cognito.ICustomAttribute } = {};

    // Always add standard tenant attributes
    userPoolAttributes.tenant_id = new cognito.StringAttribute({ mutable: true });
    userPoolAttributes.tier = new cognito.StringAttribute({ mutable: true });
    userPoolAttributes.plan = new cognito.StringAttribute({ mutable: true });

    // Add custom attributes
    customAttributes.forEach(attr => {
      userPoolAttributes[attr] = new cognito.StringAttribute({ mutable: true });
    });

    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${appName}-users`,
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
        username: false,
      },
      signInCaseSensitive: false,
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
        phoneNumber: {
          required: false,
          mutable: true,
        },
        givenName: {
          required: false,
          mutable: true,
        },
        familyName: {
          required: false,
          mutable: true,
        },
      },
      customAttributes: userPoolAttributes,
      passwordPolicy: passwordPolicy || {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      mfa: mfaRequired ? cognito.Mfa.REQUIRED : cognito.Mfa.OFF,
      mfaSecondFactor: {
        sms: true,
        otp: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      lambdaTriggers: {
        postConfirmation: this.postConfirmationTrigger,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Users may edit their profile and any extra custom attributes, but never
    // tenant_id, tier or plan. Those are set by the trigger or an administrator.
    const writeAttributes = new cognito.ClientAttributes()
      .withStandardAttributes({ email: true, phoneNumber: true, givenName: true, familyName: true })
      .withCustomAttributes(...customAttributes);
    const readAttributes = writeAttributes
      .withStandardAttributes({ emailVerified: true, phoneNumberVerified: true })
      .withCustomAttributes('tenant_id', 'tier', 'plan');

    // Create User Pool Client
    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      readAttributes,
      writeAttributes,
      userPoolClientName: `${appName}-client`,
      generateSecret: false,
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: callbackUrls,
        logoutUrls: logoutUrls,
      },
      preventUserExistenceErrors: true,
      refreshTokenValidity: cdk.Duration.days(30),
      accessTokenValidity: cdk.Duration.minutes(60),
      idTokenValidity: cdk.Duration.minutes(60),
    });

    // Create domain if prefix provided
    if (domainPrefix) {
      this.userPoolDomain = new cognito.UserPoolDomain(this, 'UserPoolDomain', {
        userPool: this.userPool,
        cognitoDomain: {
          domainPrefix: domainPrefix,
        },
      });
    }

    this.appName = appName;

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'MultiTenantAuth');

    // Output important values
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-UserPoolId`,
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-UserPoolClientId`,
    });

    new cdk.CfnOutput(this, 'TenantsTableName', {
      value: this.tenantsTable.tableName,
      description: 'DynamoDB Tenants Table Name',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-TenantsTableName`,
    });

    new cdk.CfnOutput(this, 'TenantsTableArn', {
      value: this.tenantsTable.tableArn,
      description: 'DynamoDB Tenants Table ARN',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-TenantsTableArn`,
    });

    if (this.userPoolDomain) {
      new cdk.CfnOutput(this, 'UserPoolDomainUrl', {
        value: `https://${this.userPoolDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
        description: 'Cognito User Pool Domain URL',
        exportName: `${cdk.Stack.of(this).stackName}-${id}-UserPoolDomainUrl`,
      });
    }
  }

  /**
   * Grant read access to the tenants table
   * @param grantee The IAM principal to grant access to
   */
  public grantTenantsTableRead(grantee: iam.IGrantable): iam.Grant {
    return this.tenantsTable.grantReadData(grantee);
  }

  /**
   * Grant write access to the tenants table
   * @param grantee The IAM principal to grant access to
   */
  public grantTenantsTableWrite(grantee: iam.IGrantable): iam.Grant {
    return this.tenantsTable.grantWriteData(grantee);
  }

  /**
   * Grant read and write access to the tenants table
   * @param grantee The IAM principal to grant access to
   */
  public grantTenantsTableReadWrite(grantee: iam.IGrantable): iam.Grant {
    return this.tenantsTable.grantReadWriteData(grantee);
  }

  /**
   * Create a pre-token generation trigger to add custom claims
   * @param lambda The Lambda function to use as trigger
   */
  public addPreTokenGenerationTrigger(lambda: lambda.Function): void {
    this.userPool.addTrigger(cognito.UserPoolOperation.PRE_TOKEN_GENERATION, lambda);
  }

  /**
   * Get the hosted UI sign-in URL
   * @param redirectUri The redirect URI after sign-in
   * @returns The sign-in URL
   */
  public getSignInUrl(redirectUri: string): string {
    if (!this.userPoolDomain) {
      throw new Error('User Pool Domain must be configured to generate sign-in URL');
    }

    const domain = `${this.userPoolDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`;
    return `https://${domain}/login?client_id=${this.userPoolClient.userPoolClientId}&response_type=code&scope=openid+email+profile&redirect_uri=${encodeURIComponent(redirectUri)}`;
  }
}