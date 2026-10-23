import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Properties for StreamlitDashboard construct
 */
export interface StreamlitDashboardProps {
  /**
   * Application name for consistent naming and tagging
   */
  readonly appName: string;

  /**
   * Path to the Dockerfile for the Streamlit application
   * Should be relative to the CDK app root or absolute
   */
  readonly dockerfilePath: string;

  /**
   * Environment variables for the container
   * @default {}
   */
  readonly envVars?: { [key: string]: string };

  /**
   * CPU units for the Fargate task (256, 512, 1024, 2048, 4096)
   * @default 256
   */
  readonly cpu?: number;

  /**
   * Memory for the Fargate task in MB
   * @default 512
   */
  readonly memory?: number;

  /**
   * Port that the Streamlit app runs on
   * @default 8501
   */
  readonly port?: number;

  /**
   * VPC to deploy the service in
   * If not provided, a new VPC will be created
   * @default undefined
   */
  readonly vpc?: ec2.IVpc;

  /**
   * Custom domain name for the dashboard
   * If provided, creates HTTPS listener with ACM certificate
   * @default undefined
   */
  readonly domainName?: string;

  /**
   * Route 53 hosted zone for custom domain
   * Required if domainName is provided
   * @default undefined
   */
  readonly hostedZone?: route53.IHostedZone;

  /**
   * Minimum number of tasks to run
   * @default 1
   */
  readonly minCapacity?: number;

  /**
   * Maximum number of tasks to run
   * @default 3
   */
  readonly maxCapacity?: number;

  /**
   * Health check path for the load balancer
   * @default '/_stcore/health'
   */
  readonly healthCheckPath?: string;

  /**
   * Enable auto-scaling based on CPU utilization
   * @default true
   */
  readonly enableAutoScaling?: boolean;

  /**
   * Target CPU utilization percentage for auto-scaling
   * @default 70
   */
  readonly cpuTargetUtilization?: number;
}

/**
 * A construct that deploys a Streamlit dashboard using ECS Fargate with
 * Application Load Balancer, auto-scaling, monitoring, and optional custom domain.
 *
 * Features:
 * - ECS Fargate cluster for serverless container deployment
 * - Application Load Balancer with health checks
 * - Auto-scaling based on CPU utilization
 * - CloudWatch logging and monitoring
 * - Optional HTTPS with custom domain and ACM certificate
 * - IAM task role with no permissions by default (use grantDynamoDBAccess / grantS3Access)
 * - Container image built from provided Dockerfile
 *
 * @example
 * ```typescript
 * new StreamlitDashboard(this, 'Dashboard', {
 *   appName: 'MyApp',
 *   dockerfilePath: './streamlit-app',
 *   envVars: {
 *     'API_BASE_URL': 'https://api.myapp.com',
 *     'ENVIRONMENT': 'production'
 *   },
 *   cpu: 512,
 *   memory: 1024,
 *   domainName: 'dashboard.myapp.com',
 *   hostedZone: myHostedZone,
 *   minCapacity: 2,
 *   maxCapacity: 10
 * });
 * ```
 */
export class StreamlitDashboard extends Construct {
  /**
   * ECS cluster running the Streamlit service
   */
  public readonly cluster: ecs.Cluster;

  /**
   * Fargate service running the Streamlit containers
   */
  public readonly service: ecs.FargateService;

  /**
   * Application Load Balancer for the service
   */
  public readonly loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;

  /**
   * ECS task definition
   */
  public readonly taskDefinition: ecs.FargateTaskDefinition;

  /**
   * IAM task role for the containers
   */
  public readonly taskRole: iam.Role;

  /**
   * CloudWatch log group for container logs
   */
  public readonly logGroup: logs.LogGroup;

  /**
   * VPC used for the deployment
   */
  public readonly vpc: ec2.IVpc;

  /**
   * Target group for the load balancer
   */
  public readonly targetGroup: elasticloadbalancingv2.ApplicationTargetGroup;

  /**
   * The URL to access the dashboard
   */
  public readonly dashboardUrl: string;

  constructor(scope: Construct, id: string, props: StreamlitDashboardProps) {
    super(scope, id);

    const {
      appName,
      dockerfilePath,
      envVars = {},
      cpu = 256,
      memory = 512,
      port = 8501,
      vpc,
      domainName,
      hostedZone,
      minCapacity = 1,
      maxCapacity = 3,
      healthCheckPath = '/_stcore/health',
      enableAutoScaling = true,
      cpuTargetUtilization = 70,
    } = props;

    // Use provided VPC or create new one
    this.vpc = vpc || new ec2.Vpc(this, 'VPC', {
      maxAzs: 2,
      natGateways: 1, // Cost optimization
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // Create ECS cluster
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `${appName}-streamlit-cluster`,
      vpc: this.vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // Create CloudWatch log group
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/${appName}-streamlit`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Create IAM task role
    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Task role for ${appName} Streamlit dashboard`,
    });

    // The task role starts with no permissions. Grant only what the dashboard reads, e.g.
    // `table.grantReadData(dashboard.taskRole)`.

    // Create task definition
    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      family: `${appName}-streamlit`,
      cpu: cpu,
      memoryLimitMiB: memory,
      taskRole: this.taskRole,
    });

    // Create container from Dockerfile
    const container = this.taskDefinition.addContainer('StreamlitContainer', {
      containerName: 'streamlit',
      image: ecs.ContainerImage.fromAsset(dockerfilePath),
      environment: {
        PORT: port.toString(),
        STREAMLIT_SERVER_PORT: port.toString(),
        STREAMLIT_SERVER_HEADLESS: 'true',
        ...envVars,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'streamlit',
        logGroup: this.logGroup,
      }),
      essential: true,
    });

    // Add port mapping
    container.addPortMappings({
      containerPort: port,
      hostPort: port,
      protocol: ecs.Protocol.TCP,
    });

    // Create Application Load Balancer
    this.loadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc: this.vpc,
      internetFacing: true,
      loadBalancerName: `${appName}-streamlit-alb`,
    });

    // Create target group
    this.targetGroup = new elasticloadbalancingv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: this.vpc,
      port: port,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      targetType: elasticloadbalancingv2.TargetType.IP,
      // Streamlit keeps session state per server; keep a browser on the same task.
      stickinessCookieDuration: cdk.Duration.hours(1),
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: healthCheckPath,
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
    });

    // Create Fargate service
    this.service = new ecs.FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: this.taskDefinition,
      serviceName: `${appName}-streamlit-service`,
      desiredCount: minCapacity,
      assignPublicIp: false,
      enableExecuteCommand: true, // For debugging
      platformVersion: ecs.FargatePlatformVersion.LATEST,
    });

    // Attach service to target group
    this.service.attachToApplicationTargetGroup(this.targetGroup);

    // Configure auto-scaling
    if (enableAutoScaling) {
      const scalableTarget = this.service.autoScaleTaskCount({
        minCapacity: minCapacity,
        maxCapacity: maxCapacity,
      });

      scalableTarget.scaleOnCpuUtilization('CpuScaling', {
        targetUtilizationPercent: cpuTargetUtilization,
        scaleInCooldown: cdk.Duration.minutes(10),
        scaleOutCooldown: cdk.Duration.minutes(5),
      });
    }

    // Configure HTTPS listener if domain provided
    if (domainName && hostedZone) {
      // Create ACM certificate
      const certificate = new certificatemanager.Certificate(this, 'Certificate', {
        domainName: domainName,
        validation: certificatemanager.CertificateValidation.fromDns(hostedZone),
      });

      // Create HTTPS listener
      this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        defaultTargetGroups: [this.targetGroup],
      });

      // Redirect HTTP to HTTPS
      this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
        defaultAction: elasticloadbalancingv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
      });

      // Create DNS record
      new route53.ARecord(this, 'AliasRecord', {
        zone: hostedZone,
        recordName: domainName,
        target: route53.RecordTarget.fromAlias(
          new route53targets.LoadBalancerTarget(this.loadBalancer)
        ),
      });

      this.dashboardUrl = `https://${domainName}`;
    } else {
      // Create HTTP listener
      this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [this.targetGroup],
      });

      this.dashboardUrl = `http://${this.loadBalancer.loadBalancerDnsName}`;
    }

    // Create monitoring
    this.createMonitoring(appName);

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'StreamlitDashboard');

    // Output important values
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: this.dashboardUrl,
      description: 'URL to access the Streamlit dashboard',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-DashboardUrl`,
    });

    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the Application Load Balancer',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-LoadBalancerDnsName`,
    });

    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'Name of the ECS cluster',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ClusterName`,
    });

    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'Name of the ECS service',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ServiceName`,
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: this.logGroup.logGroupName,
      description: 'CloudWatch log group for container logs',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-LogGroupName`,
    });
  }

  /**
   * Create CloudWatch monitoring for the dashboard
   */
  private createMonitoring(appName: string): void {
    // CPU utilization alarm
    new cloudwatch.Alarm(this, 'HighCpuAlarm', {
      alarmName: `${appName}-streamlit-high-cpu`,
      alarmDescription: `High CPU utilization for ${appName} Streamlit dashboard`,
      metric: this.service.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Memory utilization alarm
    new cloudwatch.Alarm(this, 'HighMemoryAlarm', {
      alarmName: `${appName}-streamlit-high-memory`,
      alarmDescription: `High memory utilization for ${appName} Streamlit dashboard`,
      metric: this.service.metricMemoryUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Target group unhealthy hosts alarm
    new cloudwatch.Alarm(this, 'UnhealthyHostsAlarm', {
      alarmName: `${appName}-streamlit-unhealthy-hosts`,
      alarmDescription: `Unhealthy hosts for ${appName} Streamlit dashboard`,
      metric: this.targetGroup.metrics.unhealthyHostCount({
        period: cdk.Duration.minutes(5),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // Load balancer response time alarm
    new cloudwatch.Alarm(this, 'HighResponseTimeAlarm', {
      alarmName: `${appName}-streamlit-high-response-time`,
      alarmDescription: `High response time for ${appName} Streamlit dashboard`,
      metric: this.targetGroup.metrics.targetResponseTime({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: 5, // 5 seconds
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  /**
   * Grant DynamoDB table permissions to the task role
   * @param table The DynamoDB table to grant access to
   * @param actions The DynamoDB actions to allow
   */
  public grantDynamoDBAccess(table: dynamodb.ITable, actions: string[] = ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:Scan']): void {
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: actions,
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      })
    );
  }

  /**
   * Grant S3 bucket permissions to the task role
   * @param bucketArn The S3 bucket ARN to grant access to
   * @param actions The S3 actions to allow
   */
  public grantS3Access(bucketArn: string, actions: string[] = ['s3:GetObject', 's3:ListBucket']): void {
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: actions,
        resources: [bucketArn, `${bucketArn}/*`],
      })
    );
  }

  /**
   * Update the desired count of the service
   * @param count The desired number of tasks
   */
  public updateDesiredCount(count: number): void {
    const cfnService = this.service.node.defaultChild as ecs.CfnService;
    cfnService.desiredCount = count;
  }
}