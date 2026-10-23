import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Compliance modes supported by ModelCard
 */
export type ModelCardComplianceMode = 'HIPAA' | 'FERPA' | 'FEDRAMP' | 'SR11-7';

/**
 * Evaluation metric for model performance
 */
export interface EvaluationMetric {
  /**
   * Name of the metric (e.g., "accuracy", "f1_score", "precision")
   */
  readonly name: string;

  /**
   * Numeric value of the metric
   */
  readonly value: number;

  /**
   * Optional unit or description
   */
  readonly unit?: string;
}

/**
 * Properties for ModelCardConstruct
 */
export interface ModelCardConstructProps {
  /**
   * Name of the machine learning model
   */
  readonly modelName: string;

  /**
   * Version of the model (e.g., "1.0.0", "2.1.3")
   */
  readonly modelVersion: string;

  /**
   * Description of the intended use cases for this model
   */
  readonly intendedUse: string;

  /**
   * Description of the training data used to create this model
   */
  readonly trainingDataDescription: string;

  /**
   * Array of evaluation metrics showing model performance
   */
  readonly evaluationMetrics: EvaluationMetric[];

  /**
   * Known limitations and constraints of the model
   */
  readonly limitations: string[];

  /**
   * Compliance mode for regulatory requirements
   * @default undefined - no specific compliance requirements
   */
  readonly complianceMode?: ModelCardComplianceMode;

  /**
   * Name of the team or organization responsible for this model
   * @default undefined - left out of the card
   */
  readonly responsibleTeam?: string;

  /**
   * Contact email for questions about this model
   * @default undefined - left out of the card
   */
  readonly contactEmail?: string;

  /**
   * Application name for consistent tagging and naming
   */
  readonly appName: string;

  /**
   * Additional metadata to include in the model card. Values are stored as strings.
   * @default {}
   */
  readonly additionalMetadata?: { [key: string]: string | number | boolean };

  /**
   * S3 bucket for storing model card artifacts
   * If not provided, a new bucket will be created
   * @default undefined
   */
  readonly artifactsBucket?: s3.IBucket;

  /**
   * Out of scope use cases that the model should not be used for
   * @default []
   */
  readonly outOfScopeUse?: string[];

  /**
   * Bias considerations and fairness analysis
   * @default undefined
   */
  readonly biasConsiderations?: string;
}

/**
 * A construct that creates a comprehensive ML model card with SageMaker Model Card,
 * S3 artifacts storage, DynamoDB metadata tracking, and audit logging.
 *
 * Features:
 * - SageMaker Model Card (status PendingReview) with intended use, evaluation metrics and caveats
 * - The same content written to S3 as JSON
 * - A DynamoDB model registry entry (written at deploy time by an AwsCustomResource)
 * - A CloudTrail trail recording reads and writes of the model card objects in S3
 * - Optional compliance tag (HIPAA, FERPA, FEDRAMP, SR11-7); it labels the card, nothing more
 *
 * @example
 * ```typescript
 * new ModelCardConstruct(this, 'SentimentModelCard', {
 *   appName: 'TextAnalysis',
 *   modelName: 'sentiment-classifier',
 *   modelVersion: '2.1.0',
 *   intendedUse: 'Classify text sentiment for customer feedback analysis',
 *   trainingDataDescription: 'Customer reviews dataset with 100K labeled examples',
 *   evaluationMetrics: [
 *     { name: 'accuracy', value: 0.94, unit: 'percentage' },
 *     { name: 'f1_score', value: 0.92 },
 *     { name: 'precision', value: 0.93 },
 *   ],
 *   limitations: [
 *     'Limited to English language text',
 *     'May struggle with sarcasm and irony',
 *     'Trained primarily on e-commerce reviews'
 *   ],
 *   complianceMode: 'FERPA',
 *   responsibleTeam: 'ML Engineering Team',
 *   contactEmail: 'ml-team@company.com'
 * });
 * ```
 */
export class ModelCardConstruct extends Construct {
  /**
   * SageMaker Model Card resource
   */
  public readonly modelCard: sagemaker.CfnModelCard;

  /**
   * S3 bucket for model card artifacts
   */
  public readonly artifactsBucket: s3.IBucket;

  /**
   * DynamoDB table for model registry
   */
  public readonly registryTable: dynamodb.Table;

  /**
   * CloudTrail for audit logging
   */
  public readonly auditTrail: cloudtrail.Trail;

  /**
   * The unique model identifier
   */
  public readonly modelId: string;

  /**
   * S3 key for the model card JSON artifact
   */
  public readonly modelCardS3Key: string;

  /**
   * Name of the SageMaker model card (modelId with characters SageMaker rejects replaced by '-')
   */
  public readonly modelCardName: string;

  private readonly content: { [key: string]: unknown };

  constructor(scope: Construct, id: string, props: ModelCardConstructProps) {
    super(scope, id);

    const {
      modelName,
      modelVersion,
      intendedUse,
      trainingDataDescription,
      evaluationMetrics,
      limitations,
      complianceMode,
      responsibleTeam,
      contactEmail,
      appName,
      additionalMetadata = {},
      artifactsBucket,
      outOfScopeUse = [],
      biasConsiderations,
    } = props;

    // Generate unique model identifier
    this.modelId = `${modelName}-${modelVersion}`;
    this.modelCardS3Key = `model-cards/${this.modelId}/model-card.json`;
    this.modelCardName = toModelCardName(this.modelId);
    const metadata = Object.fromEntries(Object.entries(additionalMetadata).map(([k, v]) => [k, String(v)]));

    // Create or use existing S3 bucket for artifacts
    this.artifactsBucket = artifactsBucket || new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: `${appName.toLowerCase()}-model-cards-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create DynamoDB table for model registry
    this.registryTable = new dynamodb.Table(this, 'ModelRegistry', {
      tableName: `${appName}-model-registry`,
      partitionKey: {
        name: 'model_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Add GSI for querying by compliance mode
    this.registryTable.addGlobalSecondaryIndex({
      indexName: 'compliance-mode-index',
      partitionKey: {
        name: 'compliance_mode',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'created_at',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.content = {
      model_name: modelName,
      model_version: modelVersion,
      model_id: this.modelId,
      intended_use: intendedUse,
      out_of_scope_use: outOfScopeUse,
      training_data_description: trainingDataDescription,
      evaluation_metrics: evaluationMetrics,
      limitations: limitations,
      bias_considerations: biasConsiderations,
      compliance_mode: complianceMode,
      responsible_team: responsibleTeam,
      contact_email: contactEmail,
      sagemaker_model_card_name: this.modelCardName,
      additional_metadata: metadata,
    };

    // Create SageMaker Model Card
    this.modelCard = new sagemaker.CfnModelCard(this, 'ModelCard', {
      modelCardName: this.modelCardName,
      modelCardStatus: 'PendingReview',
      content: {
        modelOverview: {
          modelDescription: `${modelName} version ${modelVersion}`,
          modelName: modelName,
          ...(responsibleTeam ? { modelOwner: responsibleTeam } : {}),
        },
        intendedUses: {
          purposeOfModel: intendedUse,
          intendedUses: intendedUse,
          factorsAffectingModelEfficiency: limitations.join('; '),
          riskRating: complianceMode ? 'High' : 'Medium',
        },
        trainingDetails: {
          trainingObservations: trainingDataDescription,
        },
        additionalInformation: {
          ethicalConsiderations: biasConsiderations || 'Not documented',
          caveatsAndRecommendations: [...limitations, ...outOfScopeUse.map((u) => `Out of scope: ${u}`)].join('; '),
          // Metrics are listed here as strings. The CloudFormation schema types the
          // evaluationDetails metric value as an object while SageMaker expects a number,
          // so that section is left out until it can be verified with a real deployment.
          customDetails: {
            ...metadata,
            ...Object.fromEntries(evaluationMetrics.map((m) => [
              `metric:${m.name}`, m.unit ? `${m.value} ${m.unit}` : String(m.value),
            ])),
          },
        },
      },
      tags: [
        { key: 'Project', value: appName },
        { key: 'ManagedBy', value: 'cdk-ai-constructs' },
        { key: 'Component', value: 'ModelCard' },
        { key: 'ModelName', value: modelName },
        { key: 'ModelVersion', value: modelVersion },
      ]
        .concat(responsibleTeam ? [{ key: 'ResponsibleTeam', value: responsibleTeam }] : [])
        .concat(complianceMode ? [{ key: 'ComplianceMode', value: complianceMode }] : []),
    });

    // Write the card JSON to S3 and the registry entry to DynamoDB at deploy time.
    // AwsCustomResource reports back to CloudFormation and passes values as JSON, so
    // user text never ends up inside generated code.
    new cr.AwsCustomResource(this, 'ModelCardJson', {
      onUpdate: {
        service: 'S3',
        action: 'putObject',
        parameters: {
          Bucket: this.artifactsBucket.bucketName,
          Key: this.modelCardS3Key,
          Body: JSON.stringify(this.content, null, 2),
          ContentType: 'application/json',
        },
        physicalResourceId: cr.PhysicalResourceId.of(`${this.modelId}-json`),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [this.artifactsBucket.arnForObjects(this.modelCardS3Key)],
      }),
      installLatestAwsSdk: false,
    });

    const values: { [key: string]: unknown } = {
      ':name': { S: modelName },
      ':version': { S: modelVersion },
      ':use': { S: intendedUse },
      ':data': { S: trainingDataDescription },
      ':metrics': { S: JSON.stringify(evaluationMetrics) },
      ':limits': { L: limitations.map((l) => ({ S: l })) },
      ':s3': { S: `s3://${this.artifactsBucket.bucketName}/${this.modelCardS3Key}` },
      ':card': { S: this.modelCardName },
      ':meta': { S: JSON.stringify(metadata) },
      // Deploy date of the first deployment; later deployments keep it.
      ':created': { S: new Date().toISOString().slice(0, 10) },
    };
    const sets = [
      'model_name = :name', 'model_version = :version', 'intended_use = :use',
      'training_data_description = :data', 'evaluation_metrics = :metrics', 'limitations = :limits',
      's3_path = :s3', 'sagemaker_model_card_name = :card', 'additional_metadata = :meta',
      'created_at = if_not_exists(created_at, :created)',
    ];
    const optional: Array<[string, string | undefined]> = [
      ['compliance_mode', complianceMode], ['responsible_team', responsibleTeam], ['contact_email', contactEmail],
    ];
    for (const [attr, value] of optional) {
      if (value) {
        values[`:${attr}`] = { S: value };
        sets.push(`${attr} = :${attr}`);
      }
    }

    const registryEntry = new cr.AwsCustomResource(this, 'RegistryEntry', {
      onUpdate: {
        service: 'DynamoDB',
        action: 'updateItem',
        parameters: {
          TableName: this.registryTable.tableName,
          Key: { model_id: { S: this.modelId } },
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeValues: values,
        },
        physicalResourceId: cr.PhysicalResourceId.of(this.modelId),
      },
      policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [this.registryTable.tableArn] }),
      installLatestAwsSdk: false,
    });
    registryEntry.node.addDependency(this.registryTable);

    // Create CloudTrail for audit logging
    this.auditTrail = new cloudtrail.Trail(this, 'ModelCardAuditTrail', {
      trailName: `${appName}-model-card-audit-trail`,
      includeGlobalServiceEvents: false,
      isMultiRegionTrail: false,
      enableFileValidation: true,
    });

    // Add data events for S3 object access
    this.auditTrail.addS3EventSelector([
      {
        bucket: this.artifactsBucket,
        objectPrefix: 'model-cards/',
      },
    ]);

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    cdk.Tags.of(this).add('Component', 'ModelCard');
    cdk.Tags.of(this).add('ModelName', modelName);
    cdk.Tags.of(this).add('ModelVersion', modelVersion);
    if (responsibleTeam) {
      cdk.Tags.of(this).add('ResponsibleTeam', responsibleTeam);
    }

    if (complianceMode) {
      cdk.Tags.of(this).add('ComplianceMode', complianceMode);
    }

    // Output important values
    new cdk.CfnOutput(this, 'ModelCardName', {
      value: this.modelCard.modelCardName,
      description: 'Name of the SageMaker Model Card',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelCardName`,
    });

    new cdk.CfnOutput(this, 'ModelCardS3Url', {
      value: `s3://${this.artifactsBucket.bucketName}/${this.modelCardS3Key}`,
      description: 'S3 URL of the model card JSON artifact',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelCardS3Url`,
    });

    new cdk.CfnOutput(this, 'ModelCardDynamoKey', {
      value: this.modelId,
      description: 'DynamoDB partition key for the model registry entry',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelCardDynamoKey`,
    });

    new cdk.CfnOutput(this, 'ModelRegistryTableName', {
      value: this.registryTable.tableName,
      description: 'Name of the DynamoDB model registry table',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelRegistryTableName`,
    });

    new cdk.CfnOutput(this, 'ModelId', {
      value: this.modelId,
      description: 'Unique identifier for this model',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-ModelId`,
    });

    new cdk.CfnOutput(this, 'AuditTrailArn', {
      value: this.auditTrail.trailArn,
      description: 'ARN of the CloudTrail audit trail',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-AuditTrailArn`,
    });
  }

  /**
   * Grant read access to the model card artifacts
   * @param grantee The IAM principal to grant access to
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    return this.artifactsBucket.grantRead(grantee, this.modelCardS3Key);
  }

  /**
   * Grant read access to the model registry table
   * @param grantee The IAM principal to grant access to
   */
  public grantRegistryRead(grantee: iam.IGrantable): iam.Grant {
    return this.registryTable.grantReadData(grantee);
  }

  /**
   * Grant write access to update model card status
   * @param grantee The IAM principal to grant access to
   */
  public grantUpdateStatus(grantee: iam.IGrantable): iam.Grant {
    return iam.Grant.addToPrincipal({
      grantee,
      actions: ['sagemaker:UpdateModelCard', 'sagemaker:DescribeModelCard'],
      resourceArns: [cdk.Stack.of(this).formatArn({
        service: 'sagemaker', resource: 'model-card', resourceName: this.modelCardName,
      })],
    });
  }

  /**
   * Update model card status
   * @param status New status for the model card
   */
  public updateStatus(status: 'Draft' | 'PendingReview' | 'Approved' | 'Archived'): void {
    const cfnModelCard = this.modelCard;
    cfnModelCard.modelCardStatus = status;
  }

  /**
   * Get the model card content as a JSON object
   * @returns Model card content object
   */
  public getModelCardContent(): { [key: string]: unknown } {
    return { ...this.content, s3_path: `s3://${this.artifactsBucket.bucketName}/${this.modelCardS3Key}` };
  }
}

/** SageMaker model card names allow letters, digits and single hyphens, up to 63 characters. */
export function toModelCardName(id: string): string {
  const name = id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63).replace(/-+$/, '');
  if (!name) {
    throw new Error(`Cannot build a model card name from "${id}"`);
  }
  return name;
}
