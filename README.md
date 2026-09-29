# Welcome to your CDK TypeScript project

This is a blank project for CDK development with TypeScript.

The `cdk.json` file tells the CDK Toolkit how to execute your app.

## Useful commands

* `npm run build`   type-check the project
* `npm run watch`   watch for changes and type-check
* `npm run test`    perform the jest unit tests
* `npx cdk deploy`  deploy this stack to your default AWS account/region
* `npx cdk diff`    compare deployed stack with current state
* `npx cdk synth`   emits the synthesized CloudFormation template

## Deploying into an environment that may not create IAM

`lib/bs-automated-testing-shared-role-stack.ts` is the same pipeline with every
function running as one execution role that already exists. It synthesizes **no
IAM resources at all** - not the five roles and five policies the normal stack
creates, and not the ones CDK would otherwise add on its own behalf for the
DynamoDB stream event sources.

Passing `execution-role-arn` swaps the whole app over to it, because `cdk deploy`
with no stack named deploys everything in the app and the two stacks want the
same bucket and function names:

```
npx cdk deploy \
  -c execution-role-arn=arn:aws:iam::<account>:role/<role> \
  -c connect-instance-id=<instance-uuid> \
  -c results-bucket-name=<globally-unique-bucket-name> \
  -c caller-number=+27123456789
```

The stack id defaults to `BsAutomatedTestingSharedRoleStack`; `-c stack-name=`
overrides it, and `buildspec.yml`'s `STACK_NAME` has to match whichever is used.
The output names are the same either way, so the buildspec's upload step needs no
other change.

Optional context, each defaulting to what the normal stack hardcodes:
`name-prefix` (prefixes all five function names, default `rsa-`),
`automated-testing-table-name`, `results-table-name`,
`call-flow-config-table-name`, `call-flow-config-flow-name`,
`default-customer-queue-flow`.

The role is imported with `mutable: false`, so it is read but never written to.
It has to already carry what the functions need - the header comment in the stack
file lists the union of the per-function grants, which an admin role covers.

Note that `cdk deploy` itself still needs a bootstrapped environment for the
Lambda bundle assets, and `cdk bootstrap` does create roles. If bootstrap is not
already done in that account, deploy with `--role-arn <the execution role>` so
CloudFormation acts as that role.

## When a test case does not run

`rsa-universal-test-cases-cdk` reads the config table's stream, and every record
it processes is logged with the key it names:

```
Processing record: pk=BM-Test-IaC-Flow, sort=2.1.AUTH123456, event=INSERT
```

**"No config item for X / Y"** means the record named an item that is no longer
in `rsa-automated-testing-cdk`. A stream record is history and the look-up is
live, so anything that deleted the item in between - a `flow-definition/` object
removed, which takes its `test-case-data/` object and every item loaded from it
with it, or a re-upload whose options are named differently from the ones they
replaced - leaves a record pointing at nothing. There is nothing to run and
nothing wrong, so it is logged and skipped: the `REMOVE` record behind it is what
deletes the test case in Connect. Records around it in the batch still run.

If the item **is** in the table, the function is reading a different one from the
one feeding it. Compare `AUTO_TEST_TABLE_NAME` on the function against the stream
ARN on its event source mapping - worth checking after a deploy of the shared-role
stack, which names its own table `<name-prefix>automated-testing-cdk`.
