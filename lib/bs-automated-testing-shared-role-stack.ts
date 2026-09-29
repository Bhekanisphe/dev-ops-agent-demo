import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as eventsources from 'aws-cdk-lib/aws-lambda-event-sources';
import { Duration } from 'aws-cdk-lib/core';
import * as path from 'path';

/**
 * The same pipeline as BsAutomatedTestingTypescriptCdkStack, for an environment
 * where a stack may not create IAM. Every function runs as one execution role
 * that already exists and already has what it needs, so this stack creates no
 * role, no managed policy and no inline policy - not even the ones CDK would add
 * on its own behalf.
 *
 * That last part is what the imported role's `mutable: false` buys: every
 * `grant*` call, and every policy CDK adds from `addEventSource`, becomes a
 * silent no-op instead of an `AWS::IAM::Policy`. The grants are therefore *not*
 * written out here - the role is expected to carry them. What the role needs is
 * the union of what the deployable stack grants per function:
 *
 *   connect:  ListContactFlows, DescribeContactFlow, DescribeContactFlowModule,
 *             ListQueues, DescribeQueue, ListHoursOfOperations,
 *             DescribeHoursOfOperation, CreateTestCase, DeleteTestCase,
 *             DescribeTestCase, ListTestCases, StartTestCaseExecution,
 *             GetTestCaseExecutionSummary, ListTestCaseExecutionRecords,
 *             TagResource
 *   lex:      DescribeBotAlias, ListBotLocales, ListIntents, DescribeIntent
 *   dynamodb: read/write on the three tables below, plus DescribeStream,
 *             GetRecords, GetShardIterator and ListStreams on the two streams
 *   s3:       GetObject, GetObjectVersion, PutObject, AbortMultipartUpload,
 *             DeleteObject, DeleteObjectVersion, ListBucket, GetBucketLocation
 *   logs:     CreateLogGroup, CreateLogStream, PutLogEvents
 *
 * An admin role covers all of it. The list is here so that tightening the role
 * later does not have to start by reading the other stack.
 */
export interface BsAutomatedTestingSharedRoleStackProps extends cdk.StackProps {
  /** The role every function assumes. Must already exist; it is never modified. */
  readonly executionRoleArn: string;
  /** The Connect instance the test cases are created on. */
  readonly connectInstanceId: string;
  /** Bucket this stack creates. S3 names are global, so it cannot be shared. */
  readonly resultsBucketName: string;
  /** Who every generated test case calls in as. */
  readonly callerNumber: string;
  readonly automatedTestingTableName?: string;
  readonly resultsTableName?: string;
  readonly callFlowConfigTableName?: string;
  readonly callFlowConfigFlowName?: string;
  /** Name of the instance's default customer queue flow, which no export gives. */
  readonly defaultCustomerQueueFlow?: string;
  /**
   * Last-resort hours of operation - an id, or a name on this instance - for a
   * flow that checks hours nowhere and queues nowhere they can be read from.
   * Not an override: the flow's own blocks and the branch's queue both win.
   */
  readonly defaultHoursOfOperation?: string;
  /** Prefixes every function name, so two of these can share an account. */
  readonly namePrefix?: string;
}

export class BsAutomatedTestingSharedRoleStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BsAutomatedTestingSharedRoleStackProps) {
    super(scope, id, props);

    const instance_id = props.connectInstanceId;
    const region = this.region;
    const account_id = this.account;
    const prefix = props.namePrefix ?? 'rsa-';

    const automatedTestingSortKey = "testing-option";
    const automatedTestingPartitionKey = "flow-name";

    // Lets the loader find the items a given config object created, so deleting
    // the object from S3 can delete them again.
    const automatedTestingSourceAttribute = "source_object_key";
    const automatedTestingSourceIndex = "source-object-index";

    const resultsTablePartitionKey = "test-case-id";
    const resultsTableSortKey = "execution-id";
    const resultsObjectName = "test-execution-results.xlsx";

    // One workbook per flow, named after the flow whose results it holds:
    // test-case-results/<FlowName>.xlsx. The same rows also go into the combined
    // workbook at the root of the bucket.
    const resultsPrefix = "test-case-results/";

    // Drop-box prefix inside the results bucket. A JSON config uploaded here is
    // loaded into the automated testing table, whose stream generates the test case.
    const testCaseDataPrefix = "test-case-data/";

    // Drop-box prefix for whole flow definitions, one object per flow:
    // flow-definition/<FlowName>.json, with <FlowName>.values.json beside it.
    const flowDefinitionPrefix = "flow-definition/";

    // The one role, imported rather than created. `mutable: false` is what keeps
    // this stack free of IAM: without it CDK would still synthesize an
    // AWS::IAM::Policy for the stream grants that addEventSource adds.
    // `addGrantsToResources: false` stops it turning those grants into resource
    // policies on the tables and the bucket instead.
    const executionRole = iam.Role.fromRoleArn(this, 'SharedExecutionRole', props.executionRoleArn, {
      mutable: false,
      addGrantsToResources: false
    });

    const resultsBucketName = props.resultsBucketName;

    const resultsBucket = new s3.Bucket(this, 'CdkBucket', {
      bucketName: resultsBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true
    });

    const automatedTestingDynamodbTable = new dynamodb.Table(this, 'AutomatedTestingTable', {
      tableName: props.automatedTestingTableName ?? `${prefix}automated-testing-cdk`,
      partitionKey: {
        name: automatedTestingPartitionKey,
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: automatedTestingSortKey,
        type: dynamodb.AttributeType.STRING
      },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    automatedTestingDynamodbTable.addGlobalSecondaryIndex({
      indexName: automatedTestingSourceIndex,
      partitionKey: {
        name: automatedTestingSourceAttribute,
        type: dynamodb.AttributeType.STRING
      },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY
    });

    const resultsDynamodbTable = new dynamodb.Table(this, 'ResultsTable', {
      tableName: props.resultsTableName ?? `${prefix}test-results-table-cdk`,
      partitionKey: {
        name: resultsTablePartitionKey,
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: resultsTableSortKey,
        type: dynamodb.AttributeType.STRING
      },
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST
    });

    const universal_test_cases = new NodejsFunction(this, 'universal_test_cases', {
      functionName: `${prefix}universal-test-cases-cdk`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      role: executionRole,
      // Long enough to see a batch of five executions through: the invocation
      // returning is what releases the next batch, so it has to outlast the
      // executions it started rather than the API calls that started them.
      timeout: Duration.seconds(900),
      // Connect runs five executions per instance at a time, so only one invocation
      // may be starting them: two shards' worth at once would be ten.
      reservedConcurrentExecutions: 1,
      entry: path.join(__dirname, '../lambda/universal-test-cases-gen.ts'),
      environment: {
        'AUTO_TEST_TABLE_NAME': automatedTestingDynamodbTable.tableName,
        'AUTO_TEST_KEY_NAME': automatedTestingPartitionKey,
        'AUTO_TEST_SORT_KEY': automatedTestingSortKey,
        'INSTANCE_ID': instance_id,
        'REGION': region,
        'ACCOUNT_ID': account_id,
        'RESULTS_TABLE_NAME': resultsDynamodbTable.tableName,
        'RESULTS_TABLE_KEY': resultsTablePartitionKey,
        'RESULTS_TABLE_SORT_KEY': resultsTableSortKey
      }
    });
    universal_test_cases.addEventSource(new eventsources.DynamoEventSource(automatedTestingDynamodbTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      // Five test cases per invocation, because Connect will only execute five at a
      // time. A shard is read one batch at a time, so the next five are not even
      // delivered until the invocation holding these has returned.
      batchSize: 5,
      maxBatchingWindow: Duration.seconds(5),
      bisectBatchOnError: true,
      retryAttempts: 15,
      // A batch too big for one invocation's clock hands the rest back rather than
      // starting executions it cannot wait for.
      reportBatchItemFailures: true
    }));

    const test_cases_loader = new NodejsFunction(this, 'test_cases_loader', {
      functionName: `${prefix}test-cases-loader-cdk`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      role: executionRole,
      timeout: Duration.seconds(300),
      entry: path.join(__dirname, '../lambda/test-cases-loader.ts'),
      environment: {
        'AUTO_TEST_TABLE_NAME': automatedTestingDynamodbTable.tableName,
        'AUTO_TEST_KEY_NAME': automatedTestingPartitionKey,
        'AUTO_TEST_SORT_KEY': automatedTestingSortKey,
        'AUTO_TEST_SOURCE_INDEX': automatedTestingSourceIndex
      }
    });

    const flow_test_cases_gen = new NodejsFunction(this, 'flow_test_cases_gen', {
      functionName: `${prefix}flow-test-cases-gen-cdk`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      role: executionRole,
      timeout: Duration.seconds(300),
      memorySize: 512,
      entry: path.join(__dirname, '../lambda/flow-test-cases-gen.ts'),
      environment: {
        'INSTANCE_ID': instance_id,
        'REGION': region,
        'FLOW_DEFINITION_PREFIX': flowDefinitionPrefix,
        'TEST_CASE_DATA_PREFIX': testCaseDataPrefix,
        'DEFAULT_CALLER_NUMBER': props.callerNumber,
        // Where a caller waits when the flow sets no CustomerQueue event hook of
        // its own. Nothing in an export names it, so it is named here.
        'DEFAULT_CUSTOMER_QUEUE_FLOW': props.defaultCustomerQueueFlow ?? 'Default customer queue',
        // Only set when asked for, so a flow that names hours nowhere fails
        // loudly instead of quietly mocking hours it has nothing to do with.
        ...(props.defaultHoursOfOperation
          ? { 'DEFAULT_HOURS_OF_OPERATION': props.defaultHoursOfOperation }
          : {}),
        'LEX_LOCALE_ID': 'en_US',
        'NO_MATCH_UTTERANCE': 'something completely unrelated to any of these options',
        'MAX_TEST_CASES': '200',
        'MAX_MENU_DEPTH': '10'
      }
    });

    // Wire the S3 trigger natively on the bucket instead of via
    // bucket.addEventNotification()/S3EventSource. Those go through CDK's
    // BucketNotificationsHandler custom resource, which brings its own Lambda
    // and its own IAM role - the two things this stack exists to avoid.
    const testCaseDataFilter: s3.CfnBucket.NotificationFilterProperty = {
      s3Key: {
        rules: [
          { name: 'prefix', value: testCaseDataPrefix },
          { name: 'suffix', value: '.json' }
        ]
      }
    };

    const flowDefinitionFilter: s3.CfnBucket.NotificationFilterProperty = {
      s3Key: {
        rules: [
          { name: 'prefix', value: flowDefinitionPrefix },
          { name: 'suffix', value: '.json' }
        ]
      }
    };

    const cfnResultsBucket = resultsBucket.node.defaultChild as s3.CfnBucket;
    cfnResultsBucket.notificationConfiguration = {
      lambdaConfigurations: [
        {
          event: 's3:ObjectCreated:*',
          filter: testCaseDataFilter,
          function: test_cases_loader.functionArn
        },
        {
          event: 's3:ObjectRemoved:*',
          filter: testCaseDataFilter,
          function: test_cases_loader.functionArn
        },
        // The generator writes into test-case-data/, so its own output fires the
        // loader above. The two prefixes never overlap, so there is no loop.
        {
          event: 's3:ObjectCreated:*',
          filter: flowDefinitionFilter,
          function: flow_test_cases_gen.functionArn
        },
        {
          event: 's3:ObjectRemoved:*',
          filter: flowDefinitionFilter,
          function: flow_test_cases_gen.functionArn
        }
      ]
    };

    // A resource policy on the function, not IAM on the role, so this is still
    // allowed here. The source ARN is built from the literal bucket name rather
    // than resultsBucket.bucketArn: the bucket carries the notification
    // configuration and so already depends on these functions, and a GetAtt back
    // the other way would close the cycle.
    for (const fn of [test_cases_loader, flow_test_cases_gen]) {
      fn.addPermission('AllowResultsBucketInvoke', {
        principal: new iam.ServicePrincipal('s3.amazonaws.com'),
        action: 'lambda:InvokeFunction',
        sourceAccount: account_id,
        sourceArn: `arn:aws:s3:::${resultsBucketName}`
      });
    }

    // S3 checks it can invoke each destination when the notification
    // configuration is written, so the permissions have to exist by then.
    for (const fn of [test_cases_loader, flow_test_cases_gen]) {
      const permission = fn.node.findChild('AllowResultsBucketInvoke') as lambda.CfnPermission;
      cfnResultsBucket.addDependency(permission);
    }

    const results_lambdaFunction = new NodejsFunction(this, 'results-lambda', {
      functionName: `${prefix}test-results-cdk`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      role: executionRole,
      // A voice test case execution runs for up to ten minutes and this function
      // waits for one to finish, so it needs longer than that to have anywhere to
      // write the result to.
      timeout: Duration.seconds(900),
      entry: path.join(__dirname, '../lambda/automated-testing-results.ts'),
      environment: {
        'INSTANCE_ID': instance_id,
        'KEY_NAME': resultsTablePartitionKey,
        'SORT_NAME': resultsTableSortKey,
        'RESULTS_BUCKET': resultsBucketName,
        'OBJECT_NAME': resultsObjectName,
        'RESULTS_PREFIX': resultsPrefix,
        'RESULTS_TABLE_NAME': resultsDynamodbTable.tableName
      }
    });
    results_lambdaFunction.addEventSource(new eventsources.DynamoEventSource(resultsDynamodbTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      bisectBatchOnError: true,
      retryAttempts: 15,
      // The results already written are checkpointed even when a later one in the
      // batch cannot be, so one result that will not finish neither duplicates the
      // rows before it nor blocks them.
      reportBatchItemFailures: true
    }));

    const callConfigTableName = props.callFlowConfigTableName ?? `${prefix}callFlowConfig`;

    const callConfigLambda = new NodejsFunction(this, 'call-config-lambda', {
      functionName: `${prefix}call-config-cdk`,
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      role: executionRole,
      timeout: Duration.seconds(300),
      entry: path.join(__dirname, '../lambda/getCallFlowConfig.ts'),
      environment: {
        'INSTANCE_ID': instance_id,
        'REGION': region,
        'ACCOUNT_ID': account_id,
        'CALL_FLOW_CONFIG_TABLE_NAME': callConfigTableName,
        'CALL_FLOW_CONFIG_KEY_VALUE': props.callFlowConfigFlowName ?? 'BM-Test-IaC-Flow',
        'CALL_FLOW_CONFIG_KEY_NAME': 'flow-name'
      }
    });

    // Same output names as the deployable stack, so buildspec.yml resolves the
    // upload target the same way whichever of the two is deployed.
    new cdk.CfnOutput(this, 'TestCaseDataBucketName', {
      value: resultsBucket.bucketName,
      description: 'Bucket the test case JSON configs are uploaded to'
    });

    new cdk.CfnOutput(this, 'TestCaseDataPrefix', {
      value: testCaseDataPrefix,
      description: 'Key prefix watched by the test case loader'
    });

    new cdk.CfnOutput(this, 'FlowDefinitionPrefix', {
      value: flowDefinitionPrefix,
      description: 'Key prefix watched by the flow test case generator; upload as <prefix><FlowName>.json'
    });

    new cdk.CfnOutput(this, 'TestCaseResultsPrefix', {
      value: resultsPrefix,
      description: 'Key prefix the per-flow result workbooks are written to, as <prefix><FlowName>.xlsx'
    });

    new cdk.CfnOutput(this, 'CallFlowConfigLambdaName', {
      value: callConfigLambda.functionName,
      description: 'Lambda function that returns the call flow config from DynamoDB'
    });

    // Which role everything runs as, and which table the call config lambda
    // reads: both are given from outside, so the deployed stack should say what
    // it was actually given rather than leaving it to the deploy command's history.
    new cdk.CfnOutput(this, 'SharedExecutionRoleArn', {
      value: props.executionRoleArn,
      description: 'Pre-existing role every function in this stack runs as'
    });

    new cdk.CfnOutput(this, 'CallFlowConfigTableName', {
      value: callConfigTableName,
      description: 'DynamoDB table the call config lambda reads; not created by this stack'
    });
  }
}
