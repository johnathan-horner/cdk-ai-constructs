import { Template } from 'aws-cdk-lib/assertions';

/** True if the template has an output whose logical ID contains `fragment`. */
export function hasOutputContaining(template: Template, fragment: string): boolean {
  return Object.keys(template.findOutputs('*')).some((id) => id.includes(fragment));
}

/** Logical IDs of all outputs, for readable failure messages. */
export function outputIds(template: Template): string[] {
  return Object.keys(template.findOutputs('*'));
}
