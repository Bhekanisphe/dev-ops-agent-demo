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



export class BsAutomatedTestingTypescriptCdkStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const instance_id = "6e669f6f-3783-4c0e-ac76-4f531575015d"
    const region = this.region
    const account_id = this.account

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
    // workbook at the root of the bucket, so a single flow's report can be handed
    // over on its own without giving up the view across all of them.
    const resultsPrefix = "test-case-results/";

    // Drop-box prefix inside the results bucket. A JSON config uploaded here is
    // loaded into the automated testing table, whose stream generates the test case.
    const testCaseDataPrefix = "test-case-data/";

    // Drop-box prefix for whole flow definitions, one object per flow:
    // flow-definition/<FlowName>.json holds the flow, and optionally every module
    // it invokes and every flow it transfers to. The generator enumerates all of
    // that flow's menu paths and writes them as a single config at
    // test-case-data/<FlowName>.json, which the loader then picks up. The file
    // name is the flow name, so a flow cannot have two definitions racing to
    // own its config - and deleting the file is what tears the flow's test cases
    // back down again.
    //
    // flow-definition/<FlowName>.values.json sits beside it and declares what the
    // flow's Lambdas answer, which no export says. It shares the prefix and the
    // ".json" suffix, so the same notification carries it; the generator tells the
    // two apart by name and regenerates the flow when the values change.
    const flowDefinitionPrefix = "flow-definition/";

    // The one value a flow definition cannot supply: who calls in. It lives in
    // cdk.json so a different account can be pointed at a different number
    // without touching this stack, or with `cdk deploy -c caller-number=...`.
    // The queue is deliberately not configurable - it is read out of the flow's
    // own blocks, per branch, so a flow whose menu options route to four
    // different queues generates four different test cases. A bundle can still
    // override the caller number under its own "defaults" key.
    const defaultCallerNumber = this.node.tryGetContext("caller-number");
    if (typeof defaultCallerNumber !== "string" || !defaultCallerNumber) {
      // Every test case executes as a call from this number, so an absent one
      // would fail at StartTestCaseExecution rather than here.
      throw new Error(
        'No "caller-number" in the cdk.json context. Add it, or pass -c caller-number=+271234567890.'
      );
    }

    // Hours are read out of the flow's own CheckHoursOfOperation block, or off
    // the queue a branch targets, per branch - that is the normal path and this
    // is not an override of it. It is only reached by a flow that checks hours
    // nowhere and queues nowhere either, which would otherwise generate nothing
    // at all: Connect mocks the check by resource, so a test case with no hours
    // id cannot be built. Optional, an id or a name, and a bundle's own
    // "defaults" still beats it.
    const defaultHoursOfOperation = this.node.tryGetContext("hours-of-operation");
    if (defaultHoursOfOperation !== undefined && typeof defaultHoursOfOperation !== "string") {
      throw new Error(
        'The "hours-of-operation" context value must be a string - an hours of operation id, or the name of one on this instance.'
      );
    }

    // example resource

    const resultsBucketName = "rsa-automated-test-cases-results";

    // Built from the literal bucket name instead of resultsBucket.bucketArn.
    // The bucket carries the S3 notification configuration, so it depends on the
    // functions it invokes; anything referencing the bucket by Ref/GetAtt from a
    // function or its role closes a circular dependency.
    const resultsBucketArn = `arn:aws:s3:::${resultsBucketName}`;

    const resultsBucket = new s3.Bucket(this, 'CdkBucket', {
      bucketName: resultsBucketName,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true
    });
    // DynamoDB Tables

    const automatedTestingDynamodbTable = new dynamodb.Table(this, 'AutomatedTestingTable', {
      tableName: "rsa-automated-testing-cdk",
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
      tableName: "rsa-test-results-table-cdk",
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

    // Connect permissions are scoped to this instance and its sub-resources.
    // DynamoDB and S3 access is granted per function further down, via the
    // resource grant helpers, so the ARNs stay correct if a resource is renamed.
    const connectInstanceArn = `arn:aws:connect:${region}:${account_id}:instance/${instance_id}`;
    const connectInstanceResources = [connectInstanceArn, `${connectInstanceArn}/*`];

    const testCaseAuthoringPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "connect:ListContactFlows",
        "connect:DescribeQueue",
        "connect:DescribeHoursOfOperation",
        "connect:CreateTestCase",
        "connect:DeleteTestCase",
        "connect:DescribeTestCase",
        "connect:ListTestCases",
        "connect:StartTestCaseExecution",
        // Read to know when a batch of five has finished, since Connect will not
        // start a sixth until it has.
        "connect:GetTestCaseExecutionSummary",
        "connect:TagResource"
      ],
      resources: connectInstanceResources
    });

    const testCaseResultsPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "connect:DescribeContactFlow",
        "connect:DescribeQueue",
        "connect:DescribeHoursOfOperation",
        "connect:GetTestCaseExecutionSummary",
        "connect:ListTestCaseExecutionRecords",
        "connect:TagResource"
      ],
      resources: connectInstanceResources
    });

    // Phone numbers are account-level resources, not nested under the instance.
    const describePhoneNumberPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ["connect:DescribePhoneNumber", "connect:TagResource"],
      resources: [`arn:aws:connect:${region}:${account_id}:phone-number/*`]
    });

    // Lambda Functions
    const universal_test_cases = new NodejsFunction(this, 'universal_test_cases', {
      functionName: "rsa-universal-test-cases-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      // Long enough to see a batch of five executions through: the invocation
      // returning is what releases the next batch, so it has to outlast the
      // executions it started rather than the API calls that started them.
      timeout: Duration.seconds(900),
      // Connect runs five executions per instance at a time, so only one invocation
      // may be starting them: two shards' worth at once would be ten.
      reservedConcurrentExecutions: 1,
      initialPolicy: [testCaseAuthoringPolicy],
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
      // delivered until the invocation holding these has returned - which it does
      // once they have finished. The window is what makes the batches full: the
      // loader writes a flow's test cases together, but they arrive on the stream as
      // they are written.
      batchSize: 5,
      maxBatchingWindow: Duration.seconds(5),
      bisectBatchOnError: true,
      retryAttempts: 15,
      // A batch too big for one invocation's clock hands the rest back rather than
      // starting executions it cannot wait for. Without this those records would be
      // checkpointed away unstarted, and those test cases would simply never run.
      reportBatchItemFailures: true
    }));

    const test_cases_loader = new NodejsFunction(this, 'test_cases_loader', {
      functionName: "rsa-test-cases-loader-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      timeout: Duration.seconds(300),
      entry: path.join(__dirname, '../lambda/test-cases-loader.ts'),
      environment: {
        'AUTO_TEST_TABLE_NAME': automatedTestingDynamodbTable.tableName,
        'AUTO_TEST_KEY_NAME': automatedTestingPartitionKey,
        'AUTO_TEST_SORT_KEY': automatedTestingSortKey,
        'AUTO_TEST_SOURCE_INDEX': automatedTestingSourceIndex
      }
    });
    // A flow definition names a queue or its hours of operation without always
    // giving the id: a CheckHoursOfOperation block with no id checks the hours
    // of the queue in effect, and the designer only stores display names.
    // Reading them off the instance keeps the generated test cases correct.
    //
    // The same is true of the flows and modules a flow hands the caller to. An
    // export names its modules by id and its customer queue flow by ARN and
    // carries neither body, so the prompts the caller hears there - a consent
    // announcement, a hold message - can only be read off the instance. Without
    // that, uploading an export means bundling those definitions by hand.
    //
    // ListContactFlows is for the one flow no export ever names: a flow that sets
    // no CustomerQueue event hook still leaves the caller in the instance's
    // default customer queue flow, which is only findable by its name.
    const flowResourceLookupPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "connect:ListQueues",
        "connect:DescribeQueue",
        "connect:ListHoursOfOperations",
        "connect:ListContactFlows",
        "connect:DescribeContactFlow",
        "connect:DescribeContactFlowModule"
      ],
      resources: connectInstanceResources
    });

    // A voice menu branches on Lex intent names, which no caller can say. The
    // phrase that reaches each branch is read off the bot the flow's block
    // names, the same way a queue named rather than identified is read off the
    // instance. Read-only, and only over the bots in this account and region -
    // a bot a Connect flow can hand a caller to always lives alongside it.
    const lexIntentLookupPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "lex:DescribeBotAlias",
        "lex:ListBotLocales",
        "lex:ListIntents",
        "lex:DescribeIntent"
      ],
      resources: [
        `arn:aws:lex:${region}:${account_id}:bot/*`,
        `arn:aws:lex:${region}:${account_id}:bot-alias/*`
      ]
    });

    // Deleting a flow definition deletes that flow's test cases in Connect. The
    // generated config going away is what removes the DynamoDB items, but only a
    // test case an item still points at gets deleted that way - one whose item a
    // re-upload dropped earlier has nothing left to delete it. Deleting by name
    // covers every test case the flow ever produced.
    const testCaseTeardownPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "connect:ListTestCases",
        "connect:DeleteTestCase"
      ],
      resources: connectInstanceResources
    });

    const flow_test_cases_gen = new NodejsFunction(this, 'flow_test_cases_gen', {
      functionName: "rsa-flow-test-cases-gen-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      timeout: Duration.seconds(300),
      memorySize: 512,
      initialPolicy: [flowResourceLookupPolicy, lexIntentLookupPolicy, testCaseTeardownPolicy],
      entry: path.join(__dirname, '../lambda/flow-test-cases-gen.ts'),
      environment: {
        'INSTANCE_ID': instance_id,
        'REGION': region,
        'FLOW_DEFINITION_PREFIX': flowDefinitionPrefix,
        'TEST_CASE_DATA_PREFIX': testCaseDataPrefix,
        'DEFAULT_CALLER_NUMBER': defaultCallerNumber,
        // Where a caller waits when the flow sets no CustomerQueue event hook of
        // its own: Connect runs the instance's default customer queue flow, and
        // the hold message the test case asserts is in there. Nothing in an
        // export names it, so it is named here - change it if this instance's
        // default has been renamed.
        'DEFAULT_CUSTOMER_QUEUE_FLOW': 'Default customer queue',
        // Last resort for a flow that names hours nowhere - see above. Left out
        // entirely when no "hours-of-operation" context is set, so the generator
        // fails loudly on such a flow rather than mocking someone else's hours.
        ...(defaultHoursOfOperation
          ? { 'DEFAULT_HOURS_OF_OPERATION': defaultHoursOfOperation }
          : {}),
        // Which of a bot's locales its sample utterances are read from, for a
        // bot alias whose own locale settings do not say.
        'LEX_LOCALE_ID': 'en_US',
        // What a voice menu's no-match test case says: something no bot should
        // match to any intent, so the flow takes its no-match branch. A
        // definition can override it under its own "defaults".
        'NO_MATCH_UTTERANCE': 'something completely unrelated to any of these options',
        // Guardrails: a flow with a deep menu tree can otherwise expand into
        // thousands of paths, each of which becomes a real Connect test case.
        'MAX_TEST_CASES': '200',
        'MAX_MENU_DEPTH': '10'
      }
    });

    // Wire the S3 trigger natively on the bucket instead of via
    // bucket.addEventNotification()/S3EventSource. Those go through CDK's
    // BucketNotificationsHandler custom resource, which needs a new IAM role
    // that this account is not allowed to create. Setting
    // NotificationConfiguration on the L1 bucket is only possible because the
    // bucket is defined in this stack, and it needs no extra role or Lambda.
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

    // S3 can only invoke the loader if the function's resource policy allows it.
    // The source ARN is built from the literal bucket name rather than
    // resultsBucket.bucketArn so this permission does not depend on the bucket,
    // which itself now depends on the function.
    test_cases_loader.addPermission('AllowResultsBucketInvoke', {
      principal: new iam.ServicePrincipal('s3.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: account_id,
      sourceArn: `arn:aws:s3:::${resultsBucketName}`
    });

    flow_test_cases_gen.addPermission('AllowResultsBucketInvoke', {
      principal: new iam.ServicePrincipal('s3.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: account_id,
      sourceArn: `arn:aws:s3:::${resultsBucketName}`
    });

    // S3 checks it can invoke each destination when the notification
    // configuration is written, so the permissions have to exist by then. This is
    // only not a cycle because the permissions above name the bucket by literal
    // ARN rather than referencing the bucket resource.
    for (const fn of [test_cases_loader, flow_test_cases_gen]) {
      const permission = fn.node.findChild('AllowResultsBucketInvoke') as lambda.CfnPermission;
      cfnResultsBucket.addDependency(permission);
    }

    const results_lambdaFunction = new NodejsFunction(this, 'results-lambda', {
      functionName: "rsa-test-results-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      // A voice test case execution runs for up to ten minutes and this function
      // waits for one to finish, so it needs longer than that to have anywhere to
      // write the result to. At five minutes it timed out mid-wait and Lambda
      // re-ran the whole batch, rewriting rows it had already written.
      timeout: Duration.seconds(900),
      initialPolicy: [testCaseResultsPolicy],
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
      // batch cannot be. Without this the shard rewinds to the start of the batch
      // on every retry, so one result that will not finish - or one that cannot be
      // read - either duplicates the rows before it or blocks them entirely.
      reportBatchItemFailures: true
    }));

    // Bucket grants, written out by hand rather than through resultsBucket.grant*,
    // which would reference the bucket by GetAtt and close the cycle described
    // above. Same actions the grant helpers use, scoped to the same key prefixes.
    const grantBucketAccess = (
      fn: lambda.Function,
      id: string,
      actions: string[],
      keyPatterns: string[]
    ) => {
      fn.addToRolePolicy(new iam.PolicyStatement({
        sid: id,
        effect: iam.Effect.ALLOW,
        actions,
        resources: keyPatterns.map(pattern => `${resultsBucketArn}/${pattern}`)
      }));
    };

    // Listing is a bucket-level action, so it cannot be scoped to a key ARN.
    // The prefix condition is what keeps each function to its own drop box.
    const grantBucketList = (fn: lambda.Function, id: string, prefixes: string[]) => {
      fn.addToRolePolicy(new iam.PolicyStatement({
        sid: id,
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket', 's3:GetBucketLocation'],
        resources: [resultsBucketArn],
        conditions: { StringLike: { 's3:prefix': prefixes } }
      }));
    };

    const readObjectActions = ['s3:GetObject', 's3:GetObjectVersion'];
    const writeObjectActions = ['s3:PutObject', 's3:AbortMultipartUpload'];
    const deleteObjectActions = ['s3:DeleteObject', 's3:DeleteObjectVersion'];

    // Data-plane grants, scoped to the exact tables and bucket each function uses.
    // The DynamoDB stream read permissions are added automatically by addEventSource.
    automatedTestingDynamodbTable.grantReadWriteData(universal_test_cases);
    resultsDynamodbTable.grantReadWriteData(universal_test_cases);

    // Read as well as write: the delete path queries the source-object index.
    automatedTestingDynamodbTable.grantReadWriteData(test_cases_loader);
    grantBucketAccess(test_cases_loader, 'ReadTestCaseData', readObjectActions, [`${testCaseDataPrefix}*`]);
    grantBucketList(test_cases_loader, 'ListTestCaseData', [`${testCaseDataPrefix}*`]);

    // Reads the flow definitions, and owns the generated configs it writes -
    // including deleting one again when its flow definition is deleted. The
    // Asking whether a key is still there tells a real delete from a versioned
    // bucket purging a noncurrent version, so it reads its own output prefix too,
    // and lists both: the question is asked as a one-key listing of the exact key,
    // since S3 answers HeadObject for a key that is not there with 403 rather than
    // 404 unless the caller can list. The prefix condition is satisfied because
    // the listing's prefix *is* the key, which sits under one of these two.
    grantBucketAccess(flow_test_cases_gen, 'ReadFlowDefinitions', readObjectActions, [
      `${flowDefinitionPrefix}*`,
      `${testCaseDataPrefix}*`
    ]);
    grantBucketList(flow_test_cases_gen, 'ListFlowDefinitionsAndConfigs', [
      `${flowDefinitionPrefix}*`,
      `${testCaseDataPrefix}*`
    ]);
    grantBucketAccess(flow_test_cases_gen, 'WriteGeneratedTestCaseData', writeObjectActions, [`${testCaseDataPrefix}*`]);
    grantBucketAccess(flow_test_cases_gen, 'DeleteGeneratedTestCaseData', deleteObjectActions, [`${testCaseDataPrefix}*`]);

    resultsDynamodbTable.grantReadWriteData(results_lambdaFunction);
    // Reads and rewrites the combined workbook at the root of the bucket, and each
    // flow's own workbook under test-case-results/.
    grantBucketAccess(results_lambdaFunction, 'ReadWriteResultsObject', [
      ...readObjectActions,
      ...writeObjectActions
    ], [resultsObjectName, `${resultsPrefix}*`]);
    // Whether a workbook is there yet is asked as a one-key listing of its exact
    // key, since S3 answers GetObject for a key that is not there with 403 rather
    // than 404 unless the caller can list - and a flow's first run has no workbook
    // by definition. The listing's prefix is the key itself, which satisfies this
    // condition.
    grantBucketList(results_lambdaFunction, 'ListResultsWorkbooks', [
      resultsObjectName,
      `${resultsPrefix}*`
    ]);

    // The buildspec uploads the JSON configs committed under test-case-data/ to
    // the drop-box prefix after the deploy, which is what triggers the loader.
    // Uploading from the build rather than from a CDK BucketDeployment keeps the
    // stack free of the custom resource, and of the IAM role that comes with it.
    // These outputs are how the build learns where to put the files.
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
    

    const callConfigLambda = new NodejsFunction(this, 'call-config-lambda', {
      functionName: "rsa-call-config-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      timeout: Duration.seconds(300),
      entry: path.join(__dirname, '../lambda/getCallFlowConfig.ts'),
      environment: {
        'INSTANCE_ID': instance_id,
        'REGION': region,
        'ACCOUNT_ID': account_id,
        'CALL_FLOW_CONFIG_TABLE_NAME': "rsa-callFlowConfig",
        'CALL_FLOW_CONFIG_KEY_VALUE': "BM-Test-IaC-Flow",
        'CALL_FLOW_CONFIG_KEY_NAME': "flow-name"
      }
    });

    callConfigLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        "dynamodb:GetItem"
      ],
      resources: [`arn:aws:dynamodb:${region}:${account_id}:table/rsa-callFlowConfig`]
    }));

    new cdk.CfnOutput(this, 'CallFlowConfigLambdaName', {
      value: callConfigLambda.functionName,
      description: 'Lambda function that returns the call flow config from DynamoDB'
    });

    const getCustRefLambda = new NodejsFunction(this, 'get-cust-ref-lambda', {
      functionName: "rsa-get-cust-ref-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      timeout: Duration.seconds(3),
      entry: path.join(__dirname, '../lambda/get-cust-ref.ts')
    });

    new cdk.CfnOutput(this, 'GetCustRefLambdaName', {
      value: getCustRefLambda.functionName,
      description: 'Lambda function that returns a customer reference number'
    });
    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'BsAutomatedTestingTypescriptCdkQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
