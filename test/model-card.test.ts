import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ModelCardConstruct, ModelCardConstructProps, toModelCardName } from '../src/constructs/model-card';
import { outputIds } from './helpers';

describe('ModelCardConstruct', () => {
  let stack: cdk.Stack;

  const baseProps: ModelCardConstructProps = {
    appName: 'TestApp',
    modelName: 'sentiment-classifier',
    modelVersion: '2.1.0',
    intendedUse: 'Classify text sentiment',
    trainingDataDescription: 'Customer feedback dataset',
    evaluationMetrics: [
      { name: 'accuracy', value: 0.94, unit: 'percentage' },
      { name: 'f1', value: 0.92 },
    ],
    limitations: ['English only', 'E-commerce bias'],
  };

  beforeEach(() => {
    stack = new cdk.Stack(new cdk.App(), 'TestStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    });
  });

  function card(template: Template): any {
    return (Object.values(template.findResources('AWS::SageMaker::ModelCard'))[0] as any).Properties;
  }

  /** Parameters of the AwsCustomResource SDK call whose logical ID contains `fragment`. */
  function sdkCall(template: Template, fragment: string): any {
    const resources = template.findResources('Custom::AWS');
    const [, res] = Object.entries(resources).find(([id]) => id.includes(fragment)) as [string, any];
    const create = res.Properties.Create ?? res.Properties.Update;
    // The SDK call is serialized as a JSON string, possibly joined with tokens.
    const json = typeof create === 'string' ? create
      : create['Fn::Join'][1].map((p: unknown) => (typeof p === 'string' ? p : 'TOKEN')).join('');
    return JSON.parse(json);
  }

  test('creates a SageMaker model card with a valid name and the given content', () => {
    new ModelCardConstruct(stack, 'TestModelCard', { ...baseProps, complianceMode: 'HIPAA' });
    const props = card(Template.fromStack(stack));

    // "2.1.0" contains dots, which SageMaker rejects in card names.
    expect(props.ModelCardName).toBe('sentiment-classifier-2-1-0');
    expect(props.ModelCardStatus).toBe('PendingReview');
    expect(props.Content.IntendedUses).toEqual(expect.objectContaining({
      IntendedUses: 'Classify text sentiment',
      FactorsAffectingModelEfficiency: 'English only; E-commerce bias',
      RiskRating: 'High',
    }));
    expect(props.Content.TrainingDetails).toEqual({ TrainingObservations: 'Customer feedback dataset' });
    expect(props.Content.AdditionalInformation.CustomDetails).toEqual({
      'metric:accuracy': '0.94 percentage',
      'metric:f1': '0.92',
    });
  });

  test('risk rating is Medium without a compliance mode', () => {
    new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    expect(card(Template.fromStack(stack)).Content.IntendedUses.RiskRating).toBe('Medium');
  });

  test('has no personal defaults for owner or contact', () => {
    const construct = new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    const json = JSON.stringify(Template.fromStack(stack).toJSON());
    expect(json).not.toMatch(/mrhorner|Shoot It|johnathan-horner/);
    expect(construct.getModelCardContent().contact_email).toBeUndefined();
    expect(card(Template.fromStack(stack)).Content.ModelOverview.ModelOwner).toBeUndefined();
  });

  test('uses the responsible team as model owner when given', () => {
    new ModelCardConstruct(stack, 'TestModelCard', { ...baseProps, responsibleTeam: 'ML Platform' });
    expect(card(Template.fromStack(stack)).Content.ModelOverview.ModelOwner).toBe('ML Platform');
  });

  test('writes the card JSON to S3 with an AwsCustomResource, not hand-written Lambda code', () => {
    new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    const template = Template.fromStack(stack);

    const call = sdkCall(template, 'ModelCardJson');
    expect(call.service).toBe('S3');
    expect(call.action).toBe('putObject');
    expect(call.parameters.Key).toBe('model-cards/sentiment-classifier-2.1.0/model-card.json');
    const body = JSON.parse(call.parameters.Body);
    expect(body.model_id).toBe('sentiment-classifier-2.1.0');
    expect(body.limitations).toEqual(['English only', 'E-commerce bias']);

    // The old inline function that never answered CloudFormation is gone.
    const inline = template.findResources('AWS::Lambda::Function', {
      Properties: { Code: { ZipFile: Match.stringLikeRegexp('put_item') } },
    });
    expect(Object.keys(inline)).toHaveLength(0);
  });

  test('writes the registry entry with updateItem and keeps the first created_at', () => {
    new ModelCardConstruct(stack, 'TestModelCard', { ...baseProps, complianceMode: 'FERPA' });
    const call = sdkCall(Template.fromStack(stack), 'RegistryEntry');

    expect(call.service).toBe('DynamoDB');
    expect(call.action).toBe('updateItem');
    expect(call.parameters.Key).toEqual({ model_id: { S: 'sentiment-classifier-2.1.0' } });
    expect(call.parameters.UpdateExpression).toContain('created_at = if_not_exists(created_at, :created)');
    expect(call.parameters.UpdateExpression).toContain('compliance_mode = :compliance_mode');
    expect(call.parameters.ExpressionAttributeValues[':limits']).toEqual({
      L: [{ S: 'English only' }, { S: 'E-commerce bias' }],
    });
  });

  test('text with quotes and an empty limitations list are passed through safely', () => {
    new ModelCardConstruct(stack, 'TestModelCard', {
      ...baseProps,
      intendedUse: "Flags a patient's chart for \"follow-up\"",
      limitations: [],
    });
    const call = sdkCall(Template.fromStack(stack), 'RegistryEntry');
    expect(call.parameters.ExpressionAttributeValues[':use']).toEqual({ S: "Flags a patient's chart for \"follow-up\"" });
    expect(call.parameters.ExpressionAttributeValues[':limits']).toEqual({ L: [] });
  });

  test('creates an encrypted, versioned, private artifacts bucket', () => {
    new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    Template.fromStack(stack).hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'testapp-model-cards-123456789012-us-east-1',
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true,
      },
    });
  });

  test('creates the DynamoDB model registry table with a compliance index', () => {
    new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'TestApp-model-registry',
      KeySchema: [{ AttributeName: 'model_id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'compliance-mode-index' })],
    });
  });

  test('creates CloudTrail for audit logging', () => {
    new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    Template.fromStack(stack).hasResourceProperties('AWS::CloudTrail::Trail', {
      TrailName: 'TestApp-model-card-audit-trail',
      EnableLogFileValidation: true,
    });
  });

  test('applies compliance mode tag when specified', () => {
    new ModelCardConstruct(stack, 'TestModelCard', { ...baseProps, complianceMode: 'SR26-2' });
    expect(card(Template.fromStack(stack)).Tags).toEqual(
      expect.arrayContaining([{ Key: 'ComplianceMode', Value: 'SR26-2' }]),
    );
  });

  test('creates required CfnOutputs', () => {
    new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    const ids = outputIds(Template.fromStack(stack)).join(' ');
    for (const name of ['ModelCardName', 'ModelCardS3Url', 'ModelRegistryTableName', 'ModelId', 'AuditTrailArn']) {
      expect(ids).toContain(name);
    }
  });

  test('getModelCardContent returns the real content', () => {
    const construct = new ModelCardConstruct(stack, 'TestModelCard', {
      ...baseProps, outOfScopeUse: ['medical advice'], additionalMetadata: { epochs: 3 },
    });
    const content = construct.getModelCardContent();
    expect(content.model_name).toBe('sentiment-classifier');
    expect(content.model_version).toBe('2.1.0');
    expect(content.out_of_scope_use).toEqual(['medical advice']);
    expect(content.additional_metadata).toEqual({ epochs: '3' });
    expect(String(content.s3_path)).toContain('model-cards/sentiment-classifier-2.1.0/model-card.json');
  });

  test('grantUpdateStatus grants a Lambda function access to this card', () => {
    const construct = new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    const fn = new lambda.Function(stack, 'Approver', {
      runtime: lambda.Runtime.PYTHON_3_12, handler: 'index.handler', code: lambda.Code.fromInline('x = 1'),
    });
    construct.grantUpdateStatus(fn);

    Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('ApproverServiceRole') }],
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['sagemaker:UpdateModelCard', 'sagemaker:DescribeModelCard'],
            Resource: {
              'Fn::Join': ['', Match.arrayWith([
                Match.stringLikeRegexp(':sagemaker:us-east-1:123456789012:model-card/sentiment-classifier-2-1-0$'),
              ])],
            },
          }),
        ]),
      },
    });
  });

  test('grantUpdateStatus also works for a plain role', () => {
    const construct = new ModelCardConstruct(stack, 'TestModelCard', baseProps);
    const role = new iam.Role(stack, 'Reviewer', { assumedBy: new iam.AccountRootPrincipal() });
    expect(construct.grantUpdateStatus(role).success).toBe(true);
  });

  test('toModelCardName keeps names within SageMaker rules', () => {
    expect(toModelCardName('fraud.model_v2 (beta)')).toBe('fraud-model-v2-beta');
    expect(toModelCardName('a'.repeat(80))).toHaveLength(63);
    expect(() => toModelCardName('...')).toThrow();
  });
});
