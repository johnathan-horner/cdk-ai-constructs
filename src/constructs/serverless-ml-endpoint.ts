import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Properties for ServerlessMLEndpoint construct
 */
export interface ServerlessMLEndpointProps {
  /**
   * S3 URI pointing to the model.tar.gz file
   * @example "s3://my-bucket/models/my-model/model.tar.gz"
   */
  readonly modelDataUrl: string;

  /**
   * SageMaker container image URI for model inference
   * @example "683313688378.dkr.ecr.us-east-1.amazonaws.com/sagemaker-scikit-learn:1.2-1-cpu-py3" (serverless endpoints are CPU only)
   */
  readonly containerImage: string;

  /**
   * Memory allocation for the serverless endpoint in MB
   * @default 2048
   */
  readonly memorySize?: number;

  /**
   * Maximum concurrent invocations
   * @default 5
   */
  readonly maxConcurrency?: number;

  /**
   * Lambda function that will invoke this endpoint
   * This function will be granted invoke permissions
   */
  readonly invokerFunction: lambda.Function;

  /**
   * Application name for consistent tagging and naming
   */
  readonly appName: string;

  /**
   * Model name for the SageMaker model
   * If not provided, will be generated from appName
   * @default undefined
   */
  readonly modelName?: string;

  /**
   * Endpoint configuration name
   * If not provided, will be generated from appName
   * @default undefined
   */
  readonly endpointConfigName?: string;

  /**
   * Endpoint name
   * If not provided, will be generated from appName
   * @default undefined
   */
  readonly endpointName?: string;

  /**
   * SNS topic ARN for error notifications
   * @default undefined
   */
  readonly errorNotificationTopicArn?: string;

  /**
   * Environment variables to pass to the model container
   * @default {}
   */
  readonly modelEnvironment?: { [key: string]: string };
}

/**
 * A construct that creates a SageMaker serverless inference endpoint
 * with monitoring, error handling, and Lambda integration.
 *
 * Features:
 * - SageMaker serverless inference configuration
 * - IAM roles with least-privilege permissions
 * - Lambda function integration with invoke permissions
 * - CloudWatch monitoring and alarms
 * - Optional SNS notifications for errors
 * - Cost-optimized serverless scaling
 *
 * @example
 * ```typescript
 * const mlLambda = new lambda.Function(this, 'MLFunction', {
 *   runtime: lambda.Runtime.PYTHON_3_11,
 *   handler: 'index.handler',
 *   code: lambda.Code.fromAsset('lambda'),
 * });
 *
 * const endpoint = new ServerlessMLEndpoint(this, 'ModelEndpoint', {
 *   appName: 'MyMLApp',
 *   modelDataUrl: 's3://my-bucket/models/sentiment-analysis/model.tar.gz',
 *   containerImage: '763104351884.dkr.ecr.us-east-1.amazonaws.com/pytorch-inference:1.12.0-gpu-py38',
 *   invokerFunction: mlLambda,
 *   maxConcurrency: 10,
 *   memorySize: 4096
 * });
 * ```
 */
export class ServerlessMLEndpoint extends Construct {
  /**
   * SageMaker model resource
   */
  public readonly model: sagemaker.CfnModel;

  /**
   * SageMaker endpoint configuration
   */
  public readonly endpointConfig: sagemaker.CfnEndpointConfig;

  /**
   * SageMaker serverless endpoint
   */
  public readonly endpoint: sagemaker.CfnEndpoint;

  /**
   * IAM role for SageMaker execution
   */
  public readonly executionRole: iam.Role;

  /**
   * CloudWatch alarm for endpoint errors
   */
  public readonly errorAlarm: cloudwatch.Alarm;

  /**
   * The name of the created endpoint
   */
  public readonly endpointName: string;

  constructor(scope: Construct, id: string, props: ServerlessMLEndpointProps) {
    super(scope, id);

    const {
      modelDataUrl,
      containerImage,
      memorySize = 2048,
      maxConcurrency = 5,
      invokerFunction,
      appName,
      modelName,
      endpointConfigName,
      endpointName,
      errorNotificationTopicArn,
      modelEnvironment = {},
    } = props;

    if (memorySize < 1024 || memorySize > 6144 || memorySize % 1024 !== 0) {
      throw new Error(`memorySize must be 1024, 2048, 3072, 4096, 5120 or 6144 MB, got ${memorySize}`);
    }
    if (maxConcurrency < 1 || maxConcurrency > 200) {
      throw new Error(`maxConcurrency must be between 1 and 200, got ${maxConcurrency}`);
    }
    const modelData = parseS3Url(modelDataUrl);

    // Generate resource names
    const modelResourceName = modelName || `${appName}-model-${cdk.Names.uniqueId(this).slice(-8)}`;
    const configResourceName = endpointConfigName || `${appName}-config-${cdk.Names.uniqueId(this).slice(-8)}`;
    this.endpointName = endpointName || `${appName}-endpoint-${cdk.Names.uniqueId(this).slice(-8)}`;

    // Create IAM role for SageMaker execution
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('sagemaker.amazonaws.com'),
      description: `Execution role for ${appName} SageMaker serverless endpoint`,
    });

    // Add S3 permissions for model data
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ModelDataAccess',
        effect: iam.Effect.ALLOW,
        actions: ['s3:GetObject'],
        resources: [`arn:aws:s3:::${modelData.bucket}/${modelData.key}`],
      })
    );

    // Add ECR permissions for container image
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ECRAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:GetAuthorizationToken',
        ],
        resources: ['*'], // ECR permissions require wildcard
      })
    );

    // Add CloudWatch permissions
    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchAccess',
        effect: iam.Effect.ALLOW,
        actions: [
          'logs:CreateLogGroup',
          'logs:CreateLogStream',
          'logs:PutLogEvents',
          'logs:DescribeLogStreams',
        ],
        resources: [cdk.Stack.of(this).formatArn({
          service: 'logs', resource: 'log-group', resourceName: '/aws/sagemaker/*',
          arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
        })],
      })
    );

    this.executionRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'CloudWatchMetrics',
        effect: iam.Effect.ALLOW,
        actions: ['cloudwatch:PutMetricData'],
        resources: ['*'], // PutMetricData does not support resource-level permissions
      })
    );

    // Create SageMaker model
    this.model = new sagemaker.CfnModel(this, 'Model', {
      modelName: modelResourceName,
      executionRoleArn: this.executionRole.roleArn,
      primaryContainer: {
        image: containerImage,
        modelDataUrl: modelDataUrl,
        environment: {
          SAGEMAKER_PROGRAM: 'inference.py',
          SAGEMAKER_SUBMIT_DIRECTORY: '/opt/ml/code',
          SAGEMAKER_CONTAINER_LOG_LEVEL: '20',
          SAGEMAKER_REGION: cdk.Stack.of(this).region,
          ...modelEnvironment,
        },
      },
    });

    // Create endpoint configuration for serverless
    this.endpointConfig = new sagemaker.CfnEndpointConfig(this, 'EndpointConfig', {
      endpointConfigName: configResourceName,
      productionVariants: [
        {
          modelName: this.model.attrModelName,
          variantName: 'primary',
          serverlessConfig: {
            maxConcurrency: maxConcurrency,
            memorySizeInMb: memorySize,
          },
        },
      ],
    });

    // Ensure model is created before endpoint config
    this.endpointConfig.addDependency(this.model);

    // Create serverless endpoint
    this.endpoint = new sagemaker.CfnEndpoint(this, 'Endpoint', {
      endpointName: this.endpointName,
      endpointConfigName: this.endpointConfig.attrEndpointConfigName,
    });

    // Ensure endpoint config is created before endpoint
    this.endpoint.addDependency(this.endpointConfig);

    // Grant invoke permissions to the Lambda function
    invokerFunction.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SageMakerInvokeEndpoint',
        effect: iam.Effect.ALLOW,
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [
          `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/${this.endpointName}`,
        ],
      })
    );

    // Add endpoint name to Lambda environment
    invokerFunction.addEnvironment('SAGEMAKER_ENDPOINT_NAME', this.endpointName);

    // Create CloudWatch alarm for endpoint errors
    this.errorAlarm = new cloudwatch.Alarm(this, 'EndpointErrorAlarm', {
      alarmName: `${appName}-sagemaker-endpoint-errors`,
      alarmDescription: `Monitor errors in ${appName} SageMaker endpoint`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'ModelLatency',
        dimensionsMap: {
          EndpointName: this.endpointName,
          VariantName: 'primary',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 30_000_000, // ModelLatency is in microseconds: 30 seconds
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add invocation error alarm
    const invocationErrorAlarm = new cloudwatch.Alarm(this, 'InvocationErrorAlarm', {
      alarmName: `${appName}-sagemaker-invocation-errors`,
      alarmDescription: `Monitor invocation errors in ${appName} SageMaker endpoint`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: 'Invocation4XXErrors',
        dimensionsMap: {
          EndpointName: this.endpointName,
          VariantName: 'primary',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS notification if topic provided
    if (errorNotificationTopicArn) {
      const topic = sns.Topic.fromTopicArn(this, 'ErrorTopic', errorNotificationTopicArn);
      this.errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
      invocationErrorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
    }

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'ServerlessMLEndpoint');

    // Output important values
    new cdk.CfnOutput(this, 'ModelName', {
      value: this.model.attrModelName,
      description: 'Name of the SageMaker model',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelName`,
    });

    new cdk.CfnOutput(this, 'EndpointName', {
      value: this.endpoint.attrEndpointName,
      description: 'Name of the SageMaker endpoint',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-EndpointName`,
    });

    new cdk.CfnOutput(this, 'EndpointArn', {
      value: `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/${this.endpointName}`,
      description: 'ARN of the SageMaker endpoint',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-EndpointArn`,
    });

    new cdk.CfnOutput(this, 'ExecutionRoleArn', {
      value: this.executionRole.roleArn,
      description: 'ARN of the SageMaker execution role',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ExecutionRoleArn`,
    });
  }

  /**
   * Grant invoke permissions to an additional Lambda function
   * @param grantee The Lambda function to grant permissions to
   */
  public grantInvoke(grantee: lambda.Function): void {
    grantee.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'SageMakerInvokeEndpoint',
        effect: iam.Effect.ALLOW,
        actions: ['sagemaker:InvokeEndpoint'],
        resources: [
          `arn:aws:sagemaker:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:endpoint/${this.endpointName}`,
        ],
      })
    );

    grantee.addEnvironment('SAGEMAKER_ENDPOINT_NAME', this.endpointName);
  }

  /**
   * Add a custom CloudWatch alarm
   * @param alarmName Name for the alarm
   * @param metricName SageMaker metric name
   * @param threshold Alarm threshold
   * @param appName Application name for alarm naming
   * @param comparisonOperator Comparison operator
   * @returns The created alarm
   */
  public addCustomAlarm(
    alarmName: string,
    metricName: string,
    threshold: number,
    appName: string,
    comparisonOperator: cloudwatch.ComparisonOperator = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
  ): cloudwatch.Alarm {
    return new cloudwatch.Alarm(this, alarmName, {
      alarmName: `${appName}-${alarmName}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SageMaker',
        metricName: metricName,
        dimensionsMap: {
          EndpointName: this.endpointName,
          VariantName: 'primary',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: threshold,
      comparisonOperator: comparisonOperator,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

/** Split `s3://bucket/key` into its parts. */
export function parseS3Url(url: string): { bucket: string; key: string } {
  if (cdk.Token.isUnresolved(url)) {
    throw new Error('modelDataUrl must be a literal s3://bucket/key string so the IAM policy can be scoped to it');
  }
  const match = url.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`modelDataUrl must look like s3://bucket/key, got ${url}`);
  }
  return { bucket: match[1], key: match[2] };
}
