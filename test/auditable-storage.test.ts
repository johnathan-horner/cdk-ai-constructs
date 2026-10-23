import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { AuditableStorage } from '../src/constructs/auditable-storage';
import { outputIds } from './helpers';

describe('AuditableStorage', () => {
  let app: cdk.App;
  let stack: cdk.Stack;

  beforeEach(() => {
    app = new cdk.App();
    stack = new cdk.Stack(app, 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
  });

  test('creates resources without error', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
    });

    const template = Template.fromStack(stack);
    expect(template).toBeDefined();
  });

  test('creates S3 bucket with correct properties', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
      enableVersioning: true,
      retentionDays: 90,
    });

    const template = Template.fromStack(stack);

    // Check S3 bucket exists
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-bucket-123456789012-us-east-1',
      VersioningConfiguration: {
        Status: 'Enabled',
      },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
            },
          },
        ],
      },
    });
  });

  test('creates KMS key for encryption', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::KMS::Key', {
      Description: 'KMS key for test-bucket bucket encryption',
      EnableKeyRotation: true,
    });
  });

  test('creates CloudTrail for auditing', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::CloudTrail::Trail', {
      TrailName: 'test-bucket-audit-trail',
      IncludeGlobalServiceEvents: true,
      IsMultiRegionTrail: true,
      EnableLogFileValidation: true,
    });
  });

  test('applies HIPAA compliance settings', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
      complianceMode: 'HIPAA',
    });

    const template = Template.fromStack(stack);

    // Should create lifecycle rule with 7-year retention
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            ExpirationInDays: 2555, // 7 years for HIPAA
          }),
        ],
      },
    });
  });

  test('creates bucket policy denying insecure connections', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
    });

    const template = Template.fromStack(stack);

    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyInsecureConnections',
            Effect: 'Deny',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
          }),
        ]),
      },
    });
  });

  test('creates required CfnOutputs', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
    });

    const template = Template.fromStack(stack);

    const ids = outputIds(template).join(' ');
    for (const name of ['BucketName', 'BucketArn', 'EncryptionKeyArn', 'AuditTrailArn']) {
      expect(ids).toContain(name);
    }
  });

  test('applies correct tags', () => {
    new AuditableStorage(stack, 'TestStorage', {
      appName: 'TestApp',
      bucketName: 'test-bucket',
    });

    const template = Template.fromStack(stack);

    // Check that resources have required tags
    template.hasResourceProperties('AWS::S3::Bucket', {
      Tags: Match.arrayWith([
        { Key: 'ManagedBy', Value: 'cdk-ai-constructs' },
        { Key: 'Project', Value: 'TestApp' },
      ]),
    });
  });

  test('compliance mode sets retention: HIPAA 2555 days, FERPA 1825 days', () => {
    new AuditableStorage(stack, 'TestStorageHipaa', {
      appName: 'TestApp',
      bucketName: 'test-bucket-hipaa',
      complianceMode: 'HIPAA',
    });
    new AuditableStorage(stack, 'TestStorageFerpa', {
      appName: 'TestApp',
      bucketName: 'test-bucket-ferpa',
      complianceMode: 'FERPA',
    });

    const template = Template.fromStack(stack);
    for (const days of [2555, 1825]) {
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: days })] },
      });
    }
  });

  test('default 90-day retention drops the 90-day Glacier transition (S3 requires transition < expiration)', () => {
    new AuditableStorage(stack, 'TestStorage', { appName: 'TestApp', bucketName: 'test-bucket' });

    const template = Template.fromStack(stack);
    const buckets = template.findResources('AWS::S3::Bucket', {
      Properties: { LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 90 })] } },
    });
    const rule = (Object.values(buckets)[0] as any).Properties.LifecycleConfiguration.Rules[0];
    const transitionDays = rule.Transitions.map((t: any) => t.TransitionInDays);
    expect(transitionDays).toEqual([30]);
  });

  test('uploads without an encryption header are allowed; non-KMS headers are denied', () => {
    new AuditableStorage(stack, 'TestStorage', { appName: 'TestApp', bucketName: 'test-bucket' });

    Template.fromStack(stack).hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'DenyUnencryptedUploads',
            Condition: {
              StringNotEqualsIfExists: { 's3:x-amz-server-side-encryption': 'aws:kms' },
              Null: { 's3:x-amz-server-side-encryption': 'false' },
            },
          }),
        ]),
      },
    });
  });
});