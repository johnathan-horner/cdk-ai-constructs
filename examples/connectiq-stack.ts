import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import {
  MultiTenantAuth,
  AuditableStorage,
  EventDrivenPipeline,
  BedrockAgentConstruct,
  StripeBilling,
  APIGatewayLambda,
  StreamlitDashboard,
} from '@johnathan-horner/cdk-ai-constructs';

/**
 * Complete ConnectIQ-style stack demonstrating how all constructs
 * work together to build a production multi-tenant AI application.
 *
 * This stack shows the architecture pattern used across ShootItPicks,
 * FinTech AI, EduAI Connect, Medical Image Triage, Transaction Anomaly
 * Detection, and Legal Document Classification systems.
 *
 * Features:
 * - Multi-tenant authentication with Cognito
 * - Secure document storage with audit trails
 * - Event-driven processing pipeline
 * - AI-powered document summarization
 * - Stripe billing integration (3 tiers)
 * - REST API with authentication
 * - Interactive Streamlit dashboard
 *
 * @example
 * ```bash
 * npm install @johnathan-horner/cdk-ai-constructs
 * cdk deploy ConnectIQStack
 * ```
 */
export class ConnectIQStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const appName = 'ConnectIQ';

    // 1. Multi-tenant Authentication
    const auth = new MultiTenantAuth(this, 'Auth', {
      appName: appName,
      callbackUrls: [
        'https://connectiq.app/dashboard',
        'http://localhost:3000/dashboard', // For development
      ],
      customAttributes: [
        'company_name',
        'industry',
        'company_size',
        'use_case',
      ],
      mfaRequired: true,
      domainPrefix: 'connectiq-auth',
    });

    // 2. Secure Document Storage (no specific compliance for ConnectIQ)
    const documentStorage = new AuditableStorage(this, 'DocumentStorage', {
      appName: appName,
      bucketName: 'documents',
      enableVersioning: true,
      retentionDays: 365, // 1 year retention
      allowedPrincipals: [], // Will be granted to specific functions
    });

    const processedStorage = new AuditableStorage(this, 'ProcessedStorage', {
      appName: appName,
      bucketName: 'processed',
      enableVersioning: true,
      retentionDays: 90,
    });

    // 3. Lambda Functions for Business Logic

    // Document processor function
    const documentProcessor = new lambda.Function(this, 'DocumentProcessor', {
      functionName: `${appName}-document-processor`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
import logging
from datetime import datetime

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client('s3')
dynamodb = boto3.resource('dynamodb')
events = boto3.client('events')

def handler(event, context):
    """
    Process uploaded documents and trigger AI summarization
    """
    try:
        # Parse S3 event
        for record in event['Records']:
            bucket = record['s3']['bucket']['name']
            key = record['s3']['object']['key']

            logger.info(f"Processing document: {key} from bucket: {bucket}")

            # Extract tenant ID from S3 key path
            # Expected format: tenants/{tenant_id}/documents/{filename}
            path_parts = key.split('/')
            if len(path_parts) >= 3 and path_parts[0] == 'tenants':
                tenant_id = path_parts[1]

                # Send event for AI processing
                events.put_events(
                    Entries=[
                        {
                            'Source': 'connectiq.documents',
                            'DetailType': 'Document Uploaded',
                            'Detail': json.dumps({
                                'tenant_id': tenant_id,
                                'bucket': bucket,
                                'key': key,
                                'timestamp': datetime.utcnow().isoformat()
                            })
                        }
                    ]
                )

                logger.info(f"Triggered AI processing for tenant {tenant_id}")

        return {'statusCode': 200, 'body': 'Processing completed'}

    except Exception as e:
        logger.error(f"Document processing error: {str(e)}")
        raise e
`),
      timeout: cdk.Duration.minutes(5),
      environment: {
        TENANTS_TABLE_NAME: auth.tenantsTable.tableName,
        PROCESSED_BUCKET: processedStorage.bucket.bucketName,
      },
    });

    // AI summarization function
    const aiSummarizer = new lambda.Function(this, 'AISummarizer', {
      functionName: `${appName}-ai-summarizer`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client('s3')
bedrock_runtime = boto3.client('bedrock-runtime')

def handler(event, context):
    """
    AI-powered document summarization using Bedrock
    """
    try:
        # Extract document details from event
        detail = event.get('detail', {})
        tenant_id = detail['tenant_id']
        bucket = detail['bucket']
        key = detail['key']

        logger.info(f"AI processing document {key} for tenant {tenant_id}")

        # Get document content from S3
        response = s3.get_object(Bucket=bucket, Key=key)
        content = response['Body'].read().decode('utf-8')

        # Truncate content if too long (Bedrock has token limits)
        if len(content) > 10000:
            content = content[:10000] + "..."

        # Call Bedrock for summarization
        model_id = os.environ.get('MODEL_ID')
        prompt = f"""
        Please provide a concise summary of the following document in 3-5 bullet points:

        {content}

        Focus on key insights, important details, and actionable items.
        """

        bedrock_response = bedrock_runtime.invoke_model(
            modelId=model_id,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 500,
                'messages': [{'role': 'user', 'content': prompt}]
            })
        )

        result = json.loads(bedrock_response['body'].read())
        summary = result['content'][0]['text']

        # Save summary to processed storage
        processed_key = f"tenants/{tenant_id}/summaries/{key.split('/')[-1]}.summary.txt"
        s3.put_object(
            Bucket=os.environ['PROCESSED_BUCKET'],
            Key=processed_key,
            Body=summary,
            ContentType='text/plain'
        )

        logger.info(f"Summary saved to {processed_key}")

        return {
            'statusCode': 200,
            'body': json.dumps({
                'summary': summary,
                'processed_key': processed_key
            })
        }

    except Exception as e:
        logger.error(f"AI summarization error: {str(e)}")
        raise e
`),
      timeout: cdk.Duration.minutes(10),
    });

    // Payment success handler
    const paymentHandler = new lambda.Function(this, 'PaymentHandler', {
      functionName: `${appName}-payment-success`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

def handler(event, context):
    """
    Handle successful payment events from Stripe
    """
    try:
        tenant_id = event.get('tenant_id')
        tier = event.get('tier')

        logger.info(f"Payment successful for tenant {tenant_id}, new tier: {tier}")

        # Additional logic could go here:
        # - Send welcome email
        # - Update feature flags
        # - Trigger onboarding workflow

        return {'statusCode': 200, 'message': 'Payment processed'}

    except Exception as e:
        logger.error(f"Payment handling error: {str(e)}")
        raise e
`),
    });

    // 4. Configure Bedrock for AI processing
    new BedrockAgentConstruct(this, 'BedrockAgent', {
      appName: appName,
      handler: aiSummarizer,
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      allowedActions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      logRetentionDays: 30,
    });

    // 5. Event-driven pipeline for document processing
    new EventDrivenPipeline(this, 'DocumentPipeline', {
      appName: appName,
      ruleName: 'ProcessDocuments',
      eventPattern: {
        source: ['connectiq.documents'],
        detailType: ['Document Uploaded'],
      },
      targetFunction: aiSummarizer,
      alarmEmail: 'admin@connectiq.app',
    });

    // 6. Stripe billing with 3 tiers
    const billing = new StripeBilling(this, 'Billing', {
      appName: appName,
      tiers: [
        {
          name: 'Starter',
          priceId: 'price_starter_monthly', // Replace with actual Stripe price ID
          amount: 2900, // $29/month
          currency: 'usd',
          interval: 'month',
        },
        {
          name: 'Growth',
          priceId: 'price_growth_monthly', // Replace with actual Stripe price ID
          amount: 9900, // $99/month
          currency: 'usd',
          interval: 'month',
        },
        {
          name: 'Pro',
          priceId: 'price_pro_monthly', // Replace with actual Stripe price ID
          amount: 29900, // $299/month
          currency: 'usd',
          interval: 'month',
        },
      ],
      stripeSecretKeyParameterName: '/connectiq/stripe/secret-key',
      webhookSecretParameterName: '/connectiq/stripe/webhook-secret',
      // Build with: pip install stripe -t layers/stripe/python
      stripeLayer: new lambda.LayerVersion(this, 'StripeLayer', {
        code: lambda.Code.fromAsset('layers/stripe'),
        compatibleRuntimes: [lambda.Runtime.PYTHON_3_12],
      }),
      authorizer: auth.authorizer,
      successUrl: 'https://connectiq.app/dashboard?payment=success',
      cancelUrl: 'https://connectiq.app/pricing?payment=cancelled',
      onPaymentSuccess: paymentHandler,
      tenantsTable: auth.tenantsTable,
    });

    // 7. API Gateway for dashboard backend
    const dashboardAPI = new APIGatewayLambda(this, 'DashboardAPI', {
      appName: appName,
      apiName: `${appName.toLowerCase()}-dashboard-api`,
      routes: [
        {
          method: 'GET',
          path: '/documents',
          handler: new lambda.Function(this, 'GetDocuments', {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json
import boto3

s3 = boto3.client('s3')

def handler(event, context):
    # Get tenant from JWT token (Cognito authorizer adds it)
    tenant_id = event['requestContext']['authorizer']['claims']['custom:tenant_id']

    # List documents for this tenant
    bucket = '${documentStorage.bucket.bucketName}'
    prefix = f"tenants/{tenant_id}/documents/"

    response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
    documents = [obj['Key'] for obj in response.get('Contents', [])]

    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({'documents': documents})
    }
`),
          }),
        },
        {
          method: 'GET',
          path: '/summaries',
          handler: new lambda.Function(this, 'GetSummaries', {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
import json
import boto3

s3 = boto3.client('s3')

def handler(event, context):
    tenant_id = event['requestContext']['authorizer']['claims']['custom:tenant_id']

    bucket = '${processedStorage.bucket.bucketName}'
    prefix = f"tenants/{tenant_id}/summaries/"

    response = s3.list_objects_v2(Bucket=bucket, Prefix=prefix)
    summaries = []

    for obj in response.get('Contents', []):
        content = s3.get_object(Bucket=bucket, Key=obj['Key'])['Body'].read().decode()
        summaries.append({
            'key': obj['Key'],
            'summary': content,
            'last_modified': obj['LastModified'].isoformat()
        })

    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': json.dumps({'summaries': summaries})
    }
`),
          }),
        },
      ],
      cognitoAuthorizer: auth.userPool,
      corsOrigins: ['https://connectiq.app', 'http://localhost:8501'],
    });

    // 8. Streamlit Dashboard
    const dashboard = new StreamlitDashboard(this, 'Dashboard', {
      appName: appName,
      dockerfilePath: './streamlit-app', // User would provide this
      envVars: {
        API_BASE_URL: dashboardAPI.api.url,
        COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
        COGNITO_CLIENT_ID: auth.userPoolClient.userPoolClientId,
        AWS_REGION: this.region,
      },
      cpu: 512,
      memory: 1024,
      minCapacity: 1,
      maxCapacity: 5,
    });

    // Grant permissions
    documentStorage.grantReadWrite(documentProcessor);
    documentStorage.grantRead(aiSummarizer);
    processedStorage.grantWrite(aiSummarizer);
    auth.grantTenantsTableReadWrite(documentProcessor);
    auth.grantTenantsTableRead(paymentHandler);

    // Grant dashboard API functions access to storage
    documentStorage.grantRead(this.node.findChild('GetDocuments') as lambda.Function);

    dashboard.grantDynamoDBAccess(auth.tenantsTable, [
      'dynamodb:GetItem',
      'dynamodb:Query',
      'dynamodb:Scan',
    ]);

    // Stack Outputs
    new cdk.CfnOutput(this, 'AuthDomain', {
      value: `https://${auth.userPoolDomain?.domainName}.auth.${this.region}.amazoncognito.com`,
      description: 'Cognito authentication domain',
    });

    new cdk.CfnOutput(this, 'DashboardURL', {
      value: dashboard.dashboardUrl,
      description: 'Streamlit dashboard URL',
    });

    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: dashboardAPI.api.url,
      description: 'Dashboard API endpoint',
    });

    new cdk.CfnOutput(this, 'BillingAPI', {
      value: billing.api.url,
      description: 'Stripe billing API endpoint',
    });

    new cdk.CfnOutput(this, 'DocumentBucket', {
      value: documentStorage.bucket.bucketName,
      description: 'Upload documents to: s3://bucket/tenants/{tenant_id}/documents/',
    });

    new cdk.CfnOutput(this, 'PricingTiers', {
      value: JSON.stringify([
        { name: 'Starter', price: '$29/month', features: 'Up to 100 documents/month' },
        { name: 'Growth', price: '$99/month', features: 'Up to 1,000 documents/month' },
        { name: 'Pro', price: '$299/month', features: 'Unlimited documents' },
      ]),
      description: 'Available pricing tiers',
    });
  }
}

// Example usage
// const app = new cdk.App();
// new ConnectIQStack(app, 'ConnectIQStack', {
//   env: {
//     account: process.env.CDK_DEFAULT_ACCOUNT,
//     region: process.env.CDK_DEFAULT_REGION,
//   },
// });