import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Properties for EventDrivenPipeline construct
 */
export interface EventDrivenPipelineProps {
  /**
   * Name for the EventBridge rule
   */
  readonly ruleName: string;

  /**
   * EventBridge event pattern to match incoming events
   * @example
   * {
   *   source: ['myapp.orders'],
   *   'detail-type': ['Order Placed'],
   *   detail: {
   *     status: ['PENDING']
   *   }
   * }
   */
  readonly eventPattern: events.EventPattern;

  /**
   * Lambda function that will process matched events
   */
  readonly targetFunction: lambda.Function;

  /**
   * Dead letter queue retention period in days
   * @default 14
   */
  readonly dlqRetentionDays?: number;

  /**
   * Email address for DLQ alarm notifications
   * If provided, creates SNS topic and email subscription
   * @default undefined
   */
  readonly alarmEmail?: string;

  /**
   * Application name for consistent tagging and naming
   */
  readonly appName: string;

  /**
   * Maximum number of retry attempts before sending to DLQ
   * @default 3
   */
  readonly maxRetryAttempts?: number;

  /**
   * EventBridge bus to create the rule on
   * @default events.EventBus.fromEventBusName(this, 'DefaultBus', 'default')
   */
  readonly eventBus?: events.IEventBus;
}

/**
 * A construct that creates an event-driven processing pipeline with EventBridge,
 * Lambda, SQS dead letter queue, and CloudWatch monitoring.
 *
 * Features:
 * - EventBridge rule with customizable event patterns
 * - Lambda function target with proper IAM permissions
 * - SQS dead letter queue for failed processing
 * - CloudWatch alarm on DLQ message depth
 * - Optional SNS email notifications for DLQ alerts
 * - Configurable retry attempts and retention policies
 *
 * @example
 * ```typescript
 * const orderProcessor = new lambda.Function(this, 'OrderProcessor', {
 *   runtime: lambda.Runtime.PYTHON_3_11,
 *   handler: 'index.handler',
 *   code: lambda.Code.fromAsset('lambda'),
 * });
 *
 * new EventDrivenPipeline(this, 'OrderPipeline', {
 *   appName: 'ECommerce',
 *   ruleName: 'ProcessNewOrders',
 *   eventPattern: {
 *     source: ['ecommerce.orders'],
 *     'detail-type': ['Order Placed'],
 *     detail: {
 *       status: ['PENDING']
 *     }
 *   },
 *   targetFunction: orderProcessor,
 *   alarmEmail: 'admin@example.com'
 * });
 * ```
 */
export class EventDrivenPipeline extends Construct {
  /**
   * EventBridge rule that matches events
   */
  public readonly eventRule: events.Rule;

  /**
   * Dead letter queue for failed event processing
   */
  public readonly deadLetterQueue: sqs.Queue;

  /**
   * CloudWatch alarm for monitoring DLQ depth
   */
  public readonly dlqAlarm: cloudwatch.Alarm;

  /**
   * SNS topic for alarm notifications (if email provided)
   */
  public readonly alarmTopic?: sns.Topic;

  /**
   * EventBridge bus used for the rule
   */
  public readonly eventBus: events.IEventBus;

  constructor(scope: Construct, id: string, props: EventDrivenPipelineProps) {
    super(scope, id);

    const {
      ruleName,
      eventPattern,
      targetFunction,
      dlqRetentionDays = 14,
      alarmEmail,
      appName,
      maxRetryAttempts = 3,
      eventBus,
    } = props;

    // Use provided event bus or default
    this.eventBus = eventBus || events.EventBus.fromEventBusName(this, 'DefaultBus', 'default');

    // Create dead letter queue
    this.deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${ruleName}-dlq`,
      retentionPeriod: cdk.Duration.days(dlqRetentionDays),
      // SSE-SQS. EventBridge cannot deliver to a queue encrypted with the AWS managed
      // KMS key (alias/aws/sqs), because that key policy cannot grant it access.
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create EventBridge rule
    this.eventRule = new events.Rule(this, 'EventRule', {
      ruleName: `${appName}-${ruleName}`,
      description: `Event rule for ${appName} - processes events matching specified pattern`,
      eventBus: this.eventBus,
      eventPattern: eventPattern,
      enabled: true,
    });

    // Add Lambda target with DLQ configuration
    this.eventRule.addTarget(
      new targets.LambdaFunction(targetFunction, {
        deadLetterQueue: this.deadLetterQueue,
        maxEventAge: cdk.Duration.hours(2),
        retryAttempts: maxRetryAttempts,
      })
    );

    // Create SNS topic for notifications if email provided
    if (alarmEmail) {
      this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
        topicName: `${appName}-${ruleName}-alerts`,
        displayName: `${appName} Event Pipeline Alerts`,
      });

      // Add email subscription
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(alarmEmail, {
          json: false,
        })
      );
    }

    // Create CloudWatch alarm for DLQ depth
    this.dlqAlarm = new cloudwatch.Alarm(this, 'DLQAlarm', {
      alarmName: `${appName}-${ruleName}-dlq-messages`,
      alarmDescription: `Monitor dead letter queue depth for ${appName} event pipeline`,
      metric: this.deadLetterQueue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add SNS notification to alarm if topic exists
    if (this.alarmTopic) {
      this.dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
    }

    // Add additional monitoring metrics
    this.createAdditionalMonitoring(targetFunction, appName, ruleName);

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'EventPipeline');

    // Output important values
    new cdk.CfnOutput(this, 'EventRuleArn', {
      value: this.eventRule.ruleArn,
      description: 'ARN of the EventBridge rule',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-EventRuleArn`,
    });

    new cdk.CfnOutput(this, 'EventRuleName', {
      value: this.eventRule.ruleName,
      description: 'Name of the EventBridge rule',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-EventRuleName`,
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueUrl', {
      value: this.deadLetterQueue.queueUrl,
      description: 'URL of the dead letter queue',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-DeadLetterQueueUrl`,
    });

    new cdk.CfnOutput(this, 'DeadLetterQueueArn', {
      value: this.deadLetterQueue.queueArn,
      description: 'ARN of the dead letter queue',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-DeadLetterQueueArn`,
    });

    if (this.alarmTopic) {
      new cdk.CfnOutput(this, 'AlarmTopicArn', {
        value: this.alarmTopic.topicArn,
        description: 'ARN of the SNS alarm topic',
        exportName: `${cdk.Stack.of(this).stackName}-${id}-AlarmTopicArn`,
      });
    }
  }

  /**
   * Create additional CloudWatch monitoring for the pipeline
   * @param targetFunction The Lambda function being monitored
   * @param appName Application name
   * @param ruleName Rule name for alarm naming
   */
  private createAdditionalMonitoring(
    targetFunction: lambda.Function,
    appName: string,
    ruleName: string
  ): void {
    // Lambda error rate alarm
    const errorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmName: `${appName}-${ruleName}-lambda-errors`,
      alarmDescription: `Monitor error rate for ${appName} event processing Lambda`,
      metric: targetFunction.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Lambda duration alarm
    const durationAlarm = new cloudwatch.Alarm(this, 'LambdaDurationAlarm', {
      alarmName: `${appName}-${ruleName}-lambda-duration`,
      alarmDescription: `Monitor execution duration for ${appName} event processing Lambda`,
      metric: targetFunction.metricDuration({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      // 80% of the timeout: duration can never exceed the timeout itself.
      threshold: 0.8 * (targetFunction.timeout?.toMilliseconds() ?? 3000),
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Add alarm actions if SNS topic exists
    if (this.alarmTopic) {
      errorAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
      durationAlarm.addAlarmAction(new cloudwatchActions.SnsAction(this.alarmTopic));
    }
  }

  /**
   * Add an additional target to the EventBridge rule
   * @param target The target to add
   */
  public addTarget(target: events.IRuleTarget): void {
    this.eventRule.addTarget(target);
  }

  /**
   * Grant permissions to publish events to the event bus
   * @param grantee The IAM principal to grant permissions to
   */
  public grantPutEvents(grantee: lambda.Function): void {
    this.eventBus.grantPutEventsTo(grantee);
  }

  /**
   * Grant permissions to consume messages from the dead letter queue
   * @param grantee The IAM principal to grant permissions to
   */
  public grantConsumeMessages(grantee: lambda.Function): void {
    this.deadLetterQueue.grantConsumeMessages(grantee);
  }

  /**
   * Create a Lambda function to process DLQ messages
   * @param functionProps Properties for the DLQ processor function
   * @returns The created Lambda function
   */
  public createDlqProcessor(functionProps: Omit<lambda.FunctionProps, 'events'>): lambda.Function {
    const dlqProcessor = new lambda.Function(this, 'DLQProcessor', {
      ...functionProps,
      description: `${functionProps.description || ''} - Processes messages from DLQ`.trim(),
    });

    // Add SQS event source
    dlqProcessor.addEventSource(
      new lambdaEventSources.SqsEventSource(this.deadLetterQueue, {
        batchSize: 1,
        maxBatchingWindow: cdk.Duration.minutes(5),
        reportBatchItemFailures: true,
      })
    );

    return dlqProcessor;
  }
}