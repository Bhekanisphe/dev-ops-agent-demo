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

    // Drop-box prefix inside the results bucket. A JSON config uploaded here is
    // loaded into the automated testing table, whose stream generates the test case.
    const testCaseDataPrefix = "test-case-data/";

    // example resource

    const resultsBucketName = "rsa-automated-test-cases-results";

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
      timeout: Duration.seconds(300),
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
      bisectBatchOnError: true,
      retryAttempts: 15
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

    const results_lambdaFunction = new NodejsFunction(this, 'results-lambda', {
      functionName: "rsa-test-results-cdk",
      runtime: lambda.Runtime.NODEJS_24_X,
      handler: 'handler',
      timeout: Duration.seconds(300),
      initialPolicy: [testCaseResultsPolicy],
      entry: path.join(__dirname, '../lambda/automated-testing-results.ts'),
      environment: {
        'INSTANCE_ID': instance_id,
        'KEY_NAME': resultsTablePartitionKey,
        'SORT_NAME': resultsTableSortKey,
        'RESULTS_BUCKET': resultsBucket.bucketName,
        'OBJECT_NAME': resultsObjectName,
        'RESULTS_TABLE_NAME': resultsDynamodbTable.tableName
      }
    });
    results_lambdaFunction.addEventSource(new eventsources.DynamoEventSource(resultsDynamodbTable, {
      startingPosition: lambda.StartingPosition.LATEST,
      bisectBatchOnError: true,
      retryAttempts: 15
    }));

    // Data-plane grants, scoped to the exact tables and bucket each function uses.
    // The DynamoDB stream read permissions are added automatically by addEventSource.
    automatedTestingDynamodbTable.grantReadWriteData(universal_test_cases);
    resultsDynamodbTable.grantReadWriteData(universal_test_cases);

    // Read as well as write: the delete path queries the source-object index.
    automatedTestingDynamodbTable.grantReadWriteData(test_cases_loader);
    resultsBucket.grantRead(test_cases_loader, `${testCaseDataPrefix}*`);

    resultsDynamodbTable.grantReadWriteData(results_lambdaFunction);
    resultsBucket.grantRead(results_lambdaFunction);
    resultsBucket.grantPut(results_lambdaFunction);

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
    

    // The code that defines your stack goes here

    // example resource
    // const queue = new sqs.Queue(this, 'BsAutomatedTestingTypescriptCdkQueue', {
    //   visibilityTimeout: cdk.Duration.seconds(300)
    // });
  }
}
