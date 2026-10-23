import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Compliance modes supported by AuditableStorage
 */
/** SR26-2 is the Federal Reserve model risk guidance formerly known as SR 11-7. */
export type ComplianceMode = 'HIPAA' | 'FERPA' | 'SR26-2';

/**
 * Properties for AuditableStorage construct
 */
export interface AuditableStorageProps {
  /**
   * Name for the S3 bucket (will be prefixed with stack name and suffixed with account/region)
   */
  readonly bucketName: string;

  /**
   * Enable S3 versioning for data protection
   * @default true
   */
  readonly enableVersioning?: boolean;

  /**
   * Data retention period in days
   * @default 90
   */
  readonly retentionDays?: number;

  /**
   * IAM principals that should have access to this bucket
   * @default []
   */
  readonly allowedPrincipals?: iam.IPrincipal[];

  /**
   * Retention preset. When set, it replaces retentionDays: HIPAA and SR26-2 keep
   * objects 2555 days (7 years), FERPA 1825 days (5 years). It changes nothing else.
   * @default undefined - retentionDays is used
   */
  readonly complianceMode?: ComplianceMode;

  /**
   * Application name for consistent tagging
   */
  readonly appName: string;
}

/**
 * A secure, auditable S3 storage construct with encryption, versioning,
 * lifecycle management, and CloudTrail logging. Supports various compliance modes.
 *
 * Features:
 * - KMS CMK encryption at rest
 * - S3 versioning for data protection
 * - Intelligent lifecycle management (IA at 30 days, Glacier at 90 days)
 * - CloudTrail audit logging scoped to this bucket
 * - Retention presets named after common regimes (HIPAA, FERPA, SR 26-2). These set
 *   retention days only; they do not make a workload compliant on their own
 * - Bucket policies enforcing SSL and encryption requirements
 *
 * @example
 * ```typescript
 * new AuditableStorage(this, 'DocumentStorage', {
 *   appName: 'MyApp',
 *   bucketName: 'documents',
 *   complianceMode: 'HIPAA',
 *   retentionDays: 2555, // 7 years for HIPAA
 *   allowedPrincipals: [lambdaFunction.role!]
 * });
 * ```
 */
export class AuditableStorage extends Construct {
  /**
   * The S3 bucket for secure storage
   */
  public readonly bucket: s3.Bucket;

  /**
   * KMS key used for bucket encryption
   */
  public readonly encryptionKey: kms.Key;

  /**
   * CloudTrail trail for audit logging
   */
  public readonly auditTrail: cloudtrail.Trail;

  constructor(scope: Construct, id: string, props: AuditableStorageProps) {
    super(scope, id);

    const {
      bucketName,
      enableVersioning = true,
      retentionDays = 90,
      allowedPrincipals = [],
      complianceMode,
      appName,
    } = props;

    // Apply compliance-specific settings
    const effectiveRetentionDays = this.getComplianceRetentionDays(complianceMode, retentionDays);

    // Create KMS key for bucket encryption
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: `KMS key for ${bucketName} bucket encryption`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Grant encryption key access to allowed principals
    allowedPrincipals.forEach((principal) => {
      this.encryptionKey.grantEncryptDecrypt(principal);
    });

    // Create S3 bucket with security best practices
    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `${bucketName}-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`,
      versioned: enableVersioning,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'OptimizeStorageCosts',
          enabled: true,
          // S3 requires every transition to happen before expiration.
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: cdk.Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: cdk.Duration.days(90) },
          ].filter((t) => t.transitionAfter.toDays() < effectiveRetentionDays),
          expiration: cdk.Duration.days(effectiveRetentionDays),
          noncurrentVersionExpiration: cdk.Duration.days(effectiveRetentionDays),
        },
      ],
    });

    // Deny non-SSL requests, and uploads that ask for a non-KMS encryption type.
    // Uploads with no encryption header are allowed: default bucket encryption applies KMS.
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyInsecureConnections',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:*'],
        resources: [this.bucket.bucketArn, this.bucket.arnForObjects('*')],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false',
          },
        },
      })
    );

    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyUnencryptedUploads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          StringNotEqualsIfExists: {
            's3:x-amz-server-side-encryption': 'aws:kms',
          },
          Null: {
            's3:x-amz-server-side-encryption': 'false',
          },
        },
      })
    );

    // Create CloudTrail for audit logging
    this.auditTrail = new cloudtrail.Trail(this, 'AuditTrail', {
      trailName: `${bucketName}-audit-trail`,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      enableFileValidation: true,
    });

    // Add data events for this specific bucket
    this.auditTrail.addS3EventSelector([
      {
        bucket: this.bucket,
        objectPrefix: '',
      },
    ]);

    // Apply consistent tagging
    cdk.Tags.of(this).add('Project', appName);
    cdk.Tags.of(this).add('ManagedBy', 'cdk-ai-constructs');
    if (complianceMode) {
      cdk.Tags.of(this).add('Compliance', complianceMode);
    }

    // Output important values
    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'Name of the auditable S3 bucket',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-BucketName`,
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucketArn,
      description: 'ARN of the auditable S3 bucket',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-BucketArn`,
    });

    new cdk.CfnOutput(this, 'EncryptionKeyArn', {
      value: this.encryptionKey.keyArn,
      description: 'ARN of the KMS encryption key',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-EncryptionKeyArn`,
    });

    new cdk.CfnOutput(this, 'AuditTrailArn', {
      value: this.auditTrail.trailArn,
      description: 'ARN of the CloudTrail audit trail',
      exportName: `${cdk.Stack.of(this).stackName}-${id}-AuditTrailArn`,
    });
  }

  /**
   * Get retention days based on compliance mode
   * @param complianceMode The compliance mode
   * @param defaultRetention The default retention period
   * @returns Effective retention period in days
   */
  private getComplianceRetentionDays(complianceMode?: ComplianceMode, defaultRetention?: number): number {
    if (!complianceMode) {
      return defaultRetention || 90;
    }

    switch (complianceMode) {
      case 'HIPAA':
        return 2555; // 7 years (preset, not a legal requirement)
      case 'FERPA':
        return 1825; // 5 years (preset, not a legal requirement)
      case 'SR26-2':
        return 2555; // 7 years
      default:
        return defaultRetention || 90;
    }
  }

  /**
   * Grant read access to an IAM principal
   * @param grantee The IAM principal to grant access to
   */
  public grantRead(grantee: iam.IGrantable): iam.Grant {
    this.encryptionKey.grantDecrypt(grantee);
    return this.bucket.grantRead(grantee);
  }

  /**
   * Grant write access to an IAM principal
   * @param grantee The IAM principal to grant access to
   */
  public grantWrite(grantee: iam.IGrantable): iam.Grant {
    this.encryptionKey.grantEncrypt(grantee);
    return this.bucket.grantWrite(grantee);
  }

  /**
   * Grant read and write access to an IAM principal
   * @param grantee The IAM principal to grant access to
   */
  public grantReadWrite(grantee: iam.IGrantable): iam.Grant {
    this.encryptionKey.grantEncryptDecrypt(grantee);
    return this.bucket.grantReadWrite(grantee);
  }
}