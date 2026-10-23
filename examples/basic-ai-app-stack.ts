import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import {
  BedrockAgentConstruct,
  APIGatewayLambda,
  AuditableStorage,
} from '@johnathan-horner/cdk-ai-constructs';

/**
 * A minimal example stack showing how to build a basic AI application
 * using the cdk-ai-constructs library.
 *
 * This stack includes:
 * - A Lambda function for AI processing
 * - Bedrock integration for AI model inference
 * - API Gateway for REST endpoints
 * - Secure S3 storage for documents and data
 *
 * @example
 * ```bash
 * npm install @johnathan-horner/cdk-ai-constructs
 * cdk deploy BasicAIAppStack
 * ```
 */
export class BasicAIAppStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const appName = 'BasicAIApp';

    // 1. Create Lambda function for AI processing
    const aiFunction = new lambda.Function(this, 'AIFunction', {
      functionName: `${appName}-ai-processor`,
      runtime: lambda.Runtime.PYTHON_3_11,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
import json
import boto3
import os
import logging

logger = logging.getLogger()
logger.setLevel(logging.INFO)

bedrock_runtime = boto3.client('bedrock-runtime')

def handler(event, context):
    """
    Basic AI processing function using Amazon Bedrock
    """
    try:
        # Parse request
        body = json.loads(event.get('body', '{}'))
        prompt = body.get('prompt', 'Hello, how can I help you?')

        # Call Bedrock model
        model_id = os.environ.get('MODEL_ID', 'anthropic.claude-3-haiku-20240307-v1:0')

        response = bedrock_runtime.invoke_model(
            modelId=model_id,
            contentType='application/json',
            accept='application/json',
            body=json.dumps({
                'anthropic_version': 'bedrock-2023-05-31',
                'max_tokens': 1000,
                'messages': [
                    {
                        'role': 'user',
                        'content': prompt
                    }
                ]
            })
        )

        # Parse response
        result = json.loads(response['body'].read())
        ai_response = result['content'][0]['text']

        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            'body': json.dumps({
                'response': ai_response,
                'model': model_id
            })
        }

    except Exception as e:
        logger.error(f"Error processing AI request: {str(e)}")
        return {
            'statusCode': 500,
            'headers': {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            },
            'body': json.dumps({
                'error': 'Internal server error',
                'message': str(e)
            })
        }
`),
      timeout: cdk.Duration.minutes(2),
      environment: {
        APP_NAME: appName,
      },
    });

    // 2. Configure Bedrock integration
    const bedrockAgent = new BedrockAgentConstruct(this, 'BedrockAgent', {
      appName: appName,
      handler: aiFunction,
      modelId: 'anthropic.claude-3-haiku-20240307-v1:0',
      allowedActions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      logRetentionDays: 30,
    });

    // 3. Create secure storage for documents and data
    const documentStorage = new AuditableStorage(this, 'DocumentStorage', {
      appName: appName,
      bucketName: 'documents',
      enableVersioning: true,
      retentionDays: 90,
      allowedPrincipals: [aiFunction.role!],
    });

    // Grant the AI function access to read/write documents
    documentStorage.grantReadWrite(aiFunction);

    // 4. Create API Gateway for REST endpoints
    const api = new APIGatewayLambda(this, 'API', {
      appName: appName,
      apiName: `${appName.toLowerCase()}-api`,
      routes: [
        {
          method: 'POST',
          path: '/chat',
          handler: aiFunction,
          requiresAuth: false, // No auth for this basic example
        },
        {
          method: 'GET',
          path: '/health',
          handler: new lambda.Function(this, 'HealthFunction', {
            runtime: lambda.Runtime.PYTHON_3_11,
            handler: 'index.handler',
            code: lambda.Code.fromInline(`
def handler(event, context):
    return {
        'statusCode': 200,
        'headers': {'Content-Type': 'application/json'},
        'body': '{"status": "healthy", "service": "basic-ai-app"}'
    }
`),
          }),
          requiresAuth: false,
        },
      ],
      corsOrigins: ['*'], // Allow all origins for demo
      enableAccessLogs: true,
    });

    // Add environment variable for S3 bucket
    aiFunction.addEnvironment('DOCUMENT_BUCKET', documentStorage.bucket.bucketName);

    // Stack outputs for easy access
    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: api.api.url,
      description: 'API Gateway endpoint URL',
    });

    new cdk.CfnOutput(this, 'ChatEndpoint', {
      value: `${api.api.url}chat`,
      description: 'AI chat endpoint - POST with {"prompt": "your question"}',
    });

    new cdk.CfnOutput(this, 'HealthEndpoint', {
      value: `${api.api.url}health`,
      description: 'Health check endpoint',
    });

    new cdk.CfnOutput(this, 'DocumentBucket', {
      value: documentStorage.bucket.bucketName,
      description: 'S3 bucket for secure document storage',
    });

    new cdk.CfnOutput(this, 'BedrockModel', {
      value: bedrockAgent.modelId,
      description: 'Bedrock model ID being used',
    });
  }
}

// Example usage in a CDK app
// const app = new cdk.App();
// new BasicAIAppStack(app, 'BasicAIAppStack', {
//   env: {
//     account: process.env.CDK_DEFAULT_ACCOUNT,
//     region: process.env.CDK_DEFAULT_REGION,
//   },
// });