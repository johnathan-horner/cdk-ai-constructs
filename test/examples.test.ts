/** The README examples live in examples/per-construct.ts. Each must synthesize. */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { buildAll } from '../examples/per-construct';

jest.mock('@johnathan-horner/cdk-ai-constructs', () => jest.requireActual('../src'), { virtual: true });

test.each([
  'BedrockAgent', 'ApiGatewayLambda', 'AuditableStorage', 'EventDrivenPipeline', 'ModelCard',
  'MultiTenantAuth', 'ServerlessMlEndpoint', 'StreamlitDashboard', 'StripeBilling',
])('%s example synthesizes', (name) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM python:3.12-slim\n');
  const stack = buildAll(new cdk.App(), dir).find((s) => s.stackName === `${name}Example`)!;
  expect(() => Template.fromStack(stack)).not.toThrow();
});
