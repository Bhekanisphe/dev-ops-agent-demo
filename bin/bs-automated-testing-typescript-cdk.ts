#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { BsAutomatedTestingTypescriptCdkStack } from '../lib/bs-automated-testing-typescript-cdk-stack';
import { BsAutomatedTestingSharedRoleStack } from '../lib/bs-automated-testing-shared-role-stack';

const app = new cdk.App();

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION };

// One execution role for everything, for an environment where a stack may not
// create IAM. Setting this swaps the whole app over to the role-free stack rather
// than adding a second one: `cdk deploy` with no stack named deploys everything
// in the app, and the two stacks own the same bucket name and function names.
//
//   cdk deploy -c execution-role-arn=arn:aws:iam::<acct>:role/<role> \
//              -c connect-instance-id=<uuid> \
//              -c results-bucket-name=<globally-unique-name>
const executionRoleArn = app.node.tryGetContext('execution-role-arn');

const required = (name: string, hint: string): string => {
  const value = app.node.tryGetContext(name);
  if (typeof value !== 'string' || !value) {
    throw new Error(`No "${name}" in the context. Pass -c ${name}=<value>. ${hint}`);
  }
  return value;
};

if (typeof executionRoleArn === 'string' && executionRoleArn) {
  new BsAutomatedTestingSharedRoleStack(
    app,
    app.node.tryGetContext('stack-name') ?? 'BsAutomatedTestingSharedRoleStack',
    {
      env,
      executionRoleArn,
      connectInstanceId: required('connect-instance-id', 'The Connect instance the test cases are created on.'),
      // S3 names are global, so this cannot be the name the other environment uses.
      resultsBucketName: required('results-bucket-name', 'Must not already exist in any account.'),
      // Every test case executes as a call from this number, so an absent one
      // would fail at StartTestCaseExecution rather than here.
      callerNumber: required('caller-number', 'Or set it in cdk.json, as the other environment does.'),
      automatedTestingTableName: app.node.tryGetContext('automated-testing-table-name'),
      resultsTableName: app.node.tryGetContext('results-table-name'),
      callFlowConfigTableName: app.node.tryGetContext('call-flow-config-table-name'),
      callFlowConfigFlowName: app.node.tryGetContext('call-flow-config-flow-name'),
      defaultCustomerQueueFlow: app.node.tryGetContext('default-customer-queue-flow'),
      // Only for a flow that names hours nowhere at all; the flow's own blocks
      // and the branch's queue are still read first.
      defaultHoursOfOperation: app.node.tryGetContext('hours-of-operation'),
      namePrefix: app.node.tryGetContext('name-prefix')
    }
  );
} else {
  new BsAutomatedTestingTypescriptCdkStack(app, 'BsAutomatedTestingTypescriptCdkStack', { env });
}
