import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Properties for BedrockAgentConstruct
 */
export interface BedrockAgentConstructProps {
  /**
   * The Bedrock model ID or cross-region inference profile ID to use.
   * Inference profile IDs start with a geography prefix such as `us.` or `global.`.
   * @default "us.anthropic.claude-opus-5-5"
   */
  readonly modelId?: string;

  /**
   * Lambda function that will invoke Bedrock services
   * The construct will grant this function the necessary Bedrock permissions
   */
  readonly handler: lambda.Function;

  /**
   * Bedrock API actions this function is allowed to perform
   * @default ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"]
   */
  readonly allowedActions?: string[];

  /**
   * CloudWatch log retention period in days. Must be a value CloudWatch Logs accepts
   * (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, ...).
   * @default 30
   */
  readonly logRetentionDays?: number;

  /**
   * Application name for consistent tagging and naming
   */
  readonly appName: string;

  /**
   * SNS topic ARN for error notifications
   * If not provided, no error notifications will be sent
   * @default undefined
   */
  readonly errorNotificationTopicArn?: string;
}

/**
 * A construct that configures a Lambda function with the necessary permissions,
 * logging, and monitoring for Amazon Bedrock AI operations.
 *
 * Features:
 * - Bedrock invoke permissions on the handler's own role, scoped to one model or inference profile
 * - CloudWatch log group with configurable retention
 * - Environment variables for model configuration
 * - CloudWatch alarm for Lambda error monitoring
 * - Optional SNS notifications for critical errors
 *
 * @example
 * ```typescript
 * const aiLambda = new lambda.Function(this, 'AIFunction', {
 *   runtime: lambda.Runtime.PYTHON_3_11,
 *   handler: 'index.handler',
 *   code: lambda.Code.fromAsset('lambda'),
 * });
 *
 * new BedrockAgentConstruct(this, 'BedrockAgent', {
 *   appName: 'MyAIApp',
 *   handler: aiLambda,
 *   modelId: 'us.anthropic.claude-sonnet-4-6',
 * });
 * ```
 */
export class BedrockAgentConstruct extends Construct {
  /**
   * The handler's execution role, which receives the Bedrock permissions
   */
  public readonly bedrockRole: iam.IRole;

  /**
   * CloudWatch log group for Bedrock invocation logging
   */
  public readonly logGroup: logs.LogGroup;

  /**
   * CloudWatch alarm for monitoring Lambda errors
   */
  public readonly errorAlarm: cloudwatch.Alarm;

  /**
   * The model ID being used by this agent
   */
  public readonly modelId: string;

  private readonly handler: lambda.Function;

  constructor(scope: Construct, id: string, props: BedrockAgentConstructProps) {
    super(scope, id);

    const {
      modelId = 'us.anthropic.claude-opus-5-5',
      handler,
      allowedActions = ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      logRetentionDays = 30,
      appName,
      errorNotificationTopicArn,
    } = props;

    if (!handler.role) {
      throw new Error('BedrockAgentConstruct: handler must have an execution role');
    }
    this.modelId = modelId;
    this.handler = handler;
    this.bedrockRole = handler.role;

    // Log group for application-level Bedrock logs. It is named by CloudFormation rather than
    // after the function, so the function can reference it without a dependency cycle.
    this.logGroup = new logs.LogGroup(this, 'BedrockLogGroup', {
      retention: toRetention(logRetentionDays),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Least-privilege Bedrock permissions on the handler's own role
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'BedrockInvokePermissions',
        effect: iam.Effect.ALLOW,
        actions: allowedActions,
        resources: bedrockModelArns(cdk.Stack.of(this), modelId),
      })
    );
    this.logGroup.grantWrite(handler);

    handler.addEnvironment('MODEL_ID', modelId);
    handler.addEnvironment('LOG_LEVEL', 'INFO');
    handler.addEnvironment('BEDROCK_LOG_GROUP', this.logGroup.logGroupName);

    // Create CloudWatch alarm for Lambda errors
    this.errorAlarm = new cloudwatch.Alarm(this, 'ErrorAlarm', {
      alarmName: `${appName}-bedrock-lambda-errors`,
      alarmDescription: `Monitor errors in ${appName} Bedrock Lambda function`,
      metric: handler.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS notification if topic provided
    if (errorNotificationTopicArn) {
      const topic = sns.Topic.fromTopicArn(this, 'ErrorTopic', errorNotificationTopicArn);
      this.errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(topic));
    }

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'BedrockAgent');

    // Output important values
    new cdk.CfnOutput(this, 'BedrockRoleArn', {
      value: this.bedrockRole.roleArn,
      description: 'ARN of the IAM role for Bedrock operations',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-BedrockRoleArn`,
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'Name of the CloudWatch log group for Bedrock logs',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-LogGroupName`,
    });

    new cdk.CfnOutput(this, 'ModelId', {
      value: this.modelId,
      description: 'Bedrock model ID configured for this agent',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelId`,
    });

    new cdk.CfnOutput(this, 'ErrorAlarmArn', {
      value: this.errorAlarm.alarmArn,
      description: 'ARN of the CloudWatch alarm for monitoring errors',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ErrorAlarmArn`,
    });
  }

  /**
   * Grant additional Bedrock permissions to the role
   * @param actions Additional Bedrock actions to allow
   * @param resources Additional Bedrock resources (model ARNs) to allow access to
   */
  public grantBedrockAccess(actions: string[], resources?: string[]): void {
    const effectiveResources = resources || bedrockModelArns(cdk.Stack.of(this), this.modelId);

    this.handler.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AdditionalBedrockPermissions',
        effect: iam.Effect.ALLOW,
        actions: actions,
        resources: effectiveResources,
      })
    );
  }

  /**
   * Add additional CloudWatch metrics and alarms
   * @param metricName Name of the custom metric
   * @param threshold Alarm threshold
   * @param comparisonOperator Comparison operator for the alarm
   * @param handler Lambda function to monitor
   * @param appName Application name for alarm naming
   */
  public addCustomMetricAlarm(
    metricName: string,
    threshold: number,
    handler: lambda.Function,
    appName: string,
    comparisonOperator: cloudwatch.ComparisonOperator = cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
  ): cloudwatch.Alarm {
    return new cloudwatch.Alarm(this, `${metricName}Alarm`, {
      alarmName: `${appName}-bedrock-${metricName}`,
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: metricName,
        dimensionsMap: {
          FunctionName: handler.functionName,
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: threshold,
      comparisonOperator: comparisonOperator,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }
}

const INFERENCE_PROFILE_PREFIX = /^(us|eu|apac|jp|au|ca|us-gov|global)\./;

/**
 * IAM resources needed to invoke a model. A cross-region inference profile needs the profile
 * itself plus the underlying foundation model in every region the profile can route to.
 */
export function bedrockModelArns(stack: cdk.Stack, modelId: string): string[] {
  const match = modelId.match(INFERENCE_PROFILE_PREFIX);
  if (!match) {
    return [`arn:aws:bedrock:${stack.region}::foundation-model/${modelId}`];
  }
  const baseModelId = modelId.slice(match[0].length);
  return [
    `arn:aws:bedrock:${stack.region}:${stack.account}:inference-profile/${modelId}`,
    `arn:aws:bedrock:*::foundation-model/${baseModelId}`,
  ];
}

function toRetention(days: number): logs.RetentionDays {
  const valid = Object.values(logs.RetentionDays).filter((v) => typeof v === 'number') as number[];
  if (!valid.includes(days)) {
    throw new Error(`logRetentionDays ${days} is not a CloudWatch Logs retention value (${valid.join(', ')})`);
  }
  return days as logs.RetentionDays;
}
