import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { StreamlitDashboard } from '../src/constructs/streamlit-dashboard';

describe('StreamlitDashboard', () => {
  let stack: cdk.Stack;
  let dockerDir: string;

  beforeAll(() => {
    dockerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamlit-'));
    fs.writeFileSync(path.join(dockerDir, 'Dockerfile'), 'FROM python:3.12-slim\n');
  });

  beforeEach(() => {
    stack = new cdk.Stack(new cdk.App(), 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  });

  function taskRoleStatements(template: Template): any[] {
    const policies = template.findResources('AWS::IAM::Policy');
    return Object.values(policies)
      .filter((p: any) => JSON.stringify(p.Properties.Roles).includes('TaskRole'))
      .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
  }

  test('runs a Fargate service behind an internet-facing ALB', () => {
    new StreamlitDashboard(stack, 'Dash', { appName: 'TestApp', dockerfilePath: dockerDir });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::Service', { LaunchType: 'FARGATE', DesiredCount: 1 });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', { Scheme: 'internet-facing' });
  });

  test('task role has no data access until granted', () => {
    new StreamlitDashboard(stack, 'Dash', { appName: 'TestApp', dockerfilePath: dockerDir });
    const actions = JSON.stringify(taskRoleStatements(Template.fromStack(stack)).map((s) => s.Action));
    expect(actions).not.toContain('dynamodb:');
    expect(actions).not.toContain('cloudwatch:GetMetricData');
  });

  test('grantDynamoDBAccess scopes access to one table', () => {
    const dash = new StreamlitDashboard(stack, 'Dash', { appName: 'TestApp', dockerfilePath: dockerDir });
    const table = new dynamodb.Table(stack, 'Results', { partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING } });
    dash.grantDynamoDBAccess(table, ['dynamodb:GetItem', 'dynamodb:Query']);

    const st = taskRoleStatements(Template.fromStack(stack)).find((s) => JSON.stringify(s.Action).includes('dynamodb:GetItem'));
    expect(JSON.stringify(st.Resource)).toContain('Results');
    expect(st.Resource).not.toContain('*');
  });

  test('sets the port Streamlit reads and checks its health endpoint', () => {
    new StreamlitDashboard(stack, 'Dash', { appName: 'TestApp', dockerfilePath: dockerDir, port: 8080 });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: [Match.objectLike({
        Environment: Match.arrayWith([{ Name: 'STREAMLIT_SERVER_PORT', Value: '8080' }]),
        PortMappings: [Match.objectLike({ ContainerPort: 8080 })],
      })],
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/_stcore/health',
      Port: 8080,
    });
  });

  test('enables sticky sessions so a browser stays on one task', () => {
    new StreamlitDashboard(stack, 'Dash', { appName: 'TestApp', dockerfilePath: dockerDir });
    Template.fromStack(stack).hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      TargetGroupAttributes: Match.arrayWith([{ Key: 'stickiness.enabled', Value: 'true' }]),
    });
  });

  test('scales on CPU between min and max capacity', () => {
    new StreamlitDashboard(stack, 'Dash', {
      appName: 'TestApp', dockerfilePath: dockerDir, minCapacity: 2, maxCapacity: 4, cpuTargetUtilization: 60,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalableTarget', { MinCapacity: 2, MaxCapacity: 4 });
    template.hasResourceProperties('AWS::ApplicationAutoScaling::ScalingPolicy', {
      TargetTrackingScalingPolicyConfiguration: Match.objectLike({ TargetValue: 60 }),
    });
  });

  test('serves plain HTTP when no domain is given', () => {
    const dash = new StreamlitDashboard(stack, 'Dash', { appName: 'TestApp', dockerfilePath: dockerDir });
    Template.fromStack(stack).hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', { Port: 80, Protocol: 'HTTP' });
    expect(dash.dashboardUrl.startsWith('http://')).toBe(true);
  });
});
