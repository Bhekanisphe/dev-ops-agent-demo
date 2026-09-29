// Connect runs five test case executions per instance at a time, so the generator
// starts five, waits for those five, and only then starts more.
//
// Connect and DynamoDB are fakes: the Connect one keeps the running executions the
// instance would, and refuses to hold more than five so a batch that leaks a slot
// is a failing test rather than a quota error in production.

jest.mock('@aws-sdk/client-connect', () => {
  const actual = jest.requireActual('@aws-sdk/client-connect');
  const send = jest.fn();
  return { ...actual, ConnectClient: jest.fn(() => ({ send })), __send: send };
});

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  const send = jest.fn();
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send })), __send: send };
});

import {
  CreateTestCaseCommand,
  DeleteTestCaseCommand,
  DescribeHoursOfOperationCommand,
  DescribeQueueCommand,
  DescribeTestCaseCommand,
  GetTestCaseExecutionSummaryCommand,
  ListContactFlowsCommand,
  ListTestCasesCommand,
  StartTestCaseExecutionCommand,
} from '@aws-sdk/client-connect';
import { GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { Context, DynamoDBRecord, DynamoDBStreamEvent } from 'aws-lambda';

const { __send: connectSend } = jest.requireMock('@aws-sdk/client-connect') as {
  __send: jest.Mock;
};
const { __send: dynamoSend } = jest.requireMock('@aws-sdk/client-dynamodb') as {
  __send: jest.Mock;
};

const FLOW_NAME = 'BM-Test-IaC-Flow';
const FLOW_ID = 'c0a1e2d3-0000-4000-8000-000000000001';
const MAX_CONCURRENT = 5;

process.env.AUTO_TEST_TABLE_NAME = 'rsa-automated-testing-cdk';
process.env.AUTO_TEST_KEY_NAME = 'flow-name';
process.env.AUTO_TEST_SORT_KEY = 'testing-option';
process.env.INSTANCE_ID = '6e669f6f-3783-4c0e-ac76-4f531575015d';
process.env.REGION = 'af-south-1';
process.env.ACCOUNT_ID = '123456789012';
process.env.RESULTS_TABLE_NAME = 'rsa-test-results-cdk';
process.env.RESULTS_TABLE_KEY = 'test-case-id';
process.env.RESULTS_TABLE_SORT_KEY = 'execution-id';
// The wait between polls, so the loop that would spend a minute of Connect's time
// spends milliseconds of the suite's.
process.env.EXECUTION_POLL_INTERVAL_MS = '5';

// Imported after the environment is set: the table, instance and poll interval are
// read once, when the module loads, exactly as they are in Lambda.
const { handler } = require('../lambda/universal-test-cases-gen') as {
  handler: (
    event: DynamoDBStreamEvent,
    context: Context
  ) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;
};

/** What the instance is doing: the executions it holds, and what it has been asked. */
interface Instance {
  /** Executions not yet finished, by execution id. */
  running: Map<string, { test_case_id: string; polls: number }>;
  /** The most executions ever held at once — five, or the batching is broken. */
  peak: number;
  /** Starts and finishes in the order they happened, so their interleaving is testable. */
  log: string[];
}

let instance: Instance;
// How many polls an execution takes to finish, so a start is never the only thing
// the fake has seen when the wait ends.
let pollsToFinish: number;
// Names StartTestCaseExecution refuses for the first call, as a full instance does.
let refuseOnce: Set<string>;

/** The Content of every test case created, parsed, so what was asserted is readable. */
let createdContent: any[];

/** Test case names CreateTestCase answers 400 on, as it does for content it will not accept. */
let refuseContentFor: Set<string>;

let counter = 0;

// Word for word what a real upload got back, including the problemDetails Connect
// puts the objection in - the reason is the only thing that names the block to fix.
const invalidContent = () => {
  const error: any = new Error('Invalid test case content ');
  error.name = 'InvalidTestCaseException';
  error.problemDetails = [
    {
      message:
        'InvalidEventProblem(observationIdentifier=flow_ended, actionIdentifier=null, reason=Invalid action type for FlowActionStarted event)',
    },
  ];
  return error;
};

const quotaExceeded = () => {
  const error: any = new Error('The allowed number of concurrent test case executions was exceeded.');
  error.name = 'ServiceQuotaExceededException';
  return error;
};

/** A lambda_mocks entry as uploads used to write it, for an item that still has one. */
let legacyLambdaMocks: { arn: string; response: Record<string, string> }[];

/** The blocks the config carries, when the default one announcement is not the point. */
let configBlocks: Record<string, any> | undefined;

/**
 * The instance's contact flows, a page per entry, as ListContactFlows hands them
 * out: one page holding the flow under test unless a test says otherwise.
 */
let flowPages: { Name: string; Id: string }[][];

/**
 * Testing options whose item is no longer in the table, as one deleted after its
 * record was written is: GetItem answers with no Item at all.
 */
let deletedOptions: Set<string>;

/** The config item the loader writes: one announcement, ending without a queue. */
const configItem = (sortKey: string) => ({
  'flow-name': { S: FLOW_NAME },
  'testing-option': { S: sortKey },
  hours_of_operation: { S: 'hoo-1' },
  hours_of_operation_results: { S: 'InHour' },
  caller_number: { S: '+27100000000' },
  description: { S: `${FLOW_NAME} ${sortKey}` },
  ...(configBlocks ?? {
    welcome_message: { M: { Observe: { M: { message: { S: 'Welcome' } } } } },
  }),
  ...(legacyLambdaMocks.length > 0
    ? {
        lambda_mocks: {
          L: legacyLambdaMocks.map((mock) => ({
            M: {
              arn: { S: mock.arn },
              response: {
                M: Object.fromEntries(
                  Object.entries(mock.response).map(([key, value]) => [key, { S: value }])
                ),
              },
            },
          })),
        },
      }
    : {}),
});

/** A stream event, one record per testing option, as an upload of one flow produces. */
const insertEvent = (...sortKeys: string[]): DynamoDBStreamEvent => ({
  Records: sortKeys.map((sortKey, index) => ({
    eventName: 'INSERT',
    dynamodb: {
      SequenceNumber: `seq-${index + 1}`,
      ApproximateCreationDateTime: 1_700_000_000 + index,
      Keys: { 'flow-name': { S: FLOW_NAME }, 'testing-option': { S: sortKey } },
    },
  })) as DynamoDBRecord[],
});

const removeRecord = (sortKey: string, sequence: string): DynamoDBRecord =>
  ({
    eventName: 'REMOVE',
    dynamodb: {
      SequenceNumber: sequence,
      ApproximateCreationDateTime: 1_700_000_000,
      Keys: { 'flow-name': { S: FLOW_NAME }, 'testing-option': { S: sortKey } },
    },
  }) as DynamoDBRecord;

const contextWith = (remaining: number): Context =>
  ({
    functionName: 'universal-test-cases',
    getRemainingTimeInMillis: () => remaining,
  }) as Context;

const starts = () => instance.log.filter((entry) => entry.startsWith('start'));

beforeEach(() => {
  instance = { running: new Map(), peak: 0, log: [] };
  configBlocks = undefined;
  flowPages = [[{ Name: FLOW_NAME, Id: FLOW_ID }]];
  deletedOptions = new Set<string>();
  legacyLambdaMocks = [];
  createdContent = [];
  refuseContentFor = new Set<string>();
  pollsToFinish = 2;
  refuseOnce = new Set<string>();
  counter = 0;

  jest.spyOn(console, 'log').mockImplementation(() => {});

  connectSend.mockReset();
  connectSend.mockImplementation(async (command: any) => {
    if (command instanceof DescribeQueueCommand) return { Queue: { Name: 'BM-Test-Sales-IaC' } };
    if (command instanceof DescribeHoursOfOperationCommand) {
      return { HoursOfOperation: { Name: 'BasicHours' } };
    }
    if (command instanceof ListContactFlowsCommand) {
      // The token is the index of the page to hand back, and is absent on the last
      // one - so a lookup that ignores it sees only the first page.
      const index = Number(command.input.NextToken ?? '0');
      return {
        ContactFlowSummaryList: flowPages[index] ?? [],
        NextToken: index + 1 < flowPages.length ? String(index + 1) : undefined,
      };
    }
    // Nothing to clean up before creating: a name this instance has not seen.
    if (command instanceof ListTestCasesCommand) return { TestCaseSummaryList: [] };
    if (command instanceof DeleteTestCaseCommand) return {};

    if (command instanceof CreateTestCaseCommand) {
      if (refuseContentFor.has(command.input.Name as string)) throw invalidContent();
      createdContent.push(JSON.parse(command.input.Content as string));
      return { TestCaseId: `test-case-${++counter}`, Name: command.input.Name };
    }

    if (command instanceof StartTestCaseExecutionCommand) {
      const testCaseId = command.input.TestCaseId as string;
      if (refuseOnce.delete(testCaseId)) throw quotaExceeded();

      // The quota the real instance enforces. Exceeding it here means the generator
      // started a sixth execution while five were still running.
      if (instance.running.size >= MAX_CONCURRENT) throw quotaExceeded();

      const executionId = `execution-${counter}`;
      instance.running.set(executionId, { test_case_id: testCaseId, polls: 0 });
      instance.peak = Math.max(instance.peak, instance.running.size);
      instance.log.push(`start:${executionId}`);
      return { TestCaseId: testCaseId, TestCaseExecutionId: executionId, Status: 'RUNNING' };
    }

    if (command instanceof DescribeTestCaseCommand) {
      return { TestCase: { Name: `${FLOW_NAME}:option-${counter}` } };
    }

    if (command instanceof GetTestCaseExecutionSummaryCommand) {
      const executionId = command.input.TestCaseExecutionId as string;
      const execution = instance.running.get(executionId);
      if (!execution) return { Status: 'PASSED' };
      if (++execution.polls < pollsToFinish) return { Status: 'RUNNING' };
      instance.running.delete(executionId);
      instance.log.push(`finish:${executionId}`);
      return { Status: 'PASSED' };
    }

    throw new Error(`unexpected Connect command ${command.constructor.name}`);
  });

  dynamoSend.mockReset();
  dynamoSend.mockImplementation(async (command: any) => {
    if (command instanceof GetItemCommand) {
      const sortKey = command.input.Key?.['testing-option']?.S ?? '';
      if (deletedOptions.has(sortKey)) return {};
      return { Item: configItem(sortKey) };
    }
    if (command instanceof PutItemCommand) return {};
    throw new Error(`unexpected DynamoDB command ${command.constructor.name}`);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('starting executions in batches of five', () => {
  it('never has more than five executions in flight', async () => {
    const options = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'];

    const result = await handler(insertEvent(...options), contextWith(900_000));

    expect(starts()).toHaveLength(options.length);
    expect(instance.peak).toBe(MAX_CONCURRENT);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('starts the sixth only once the first five have finished', async () => {
    await handler(insertEvent('o1', 'o2', 'o3', 'o4', 'o5', 'o6'), contextWith(900_000));

    const sixthStart = instance.log.indexOf('start:execution-6');
    const before = instance.log.slice(0, sixthStart);

    expect(sixthStart).toBeGreaterThan(0);
    expect(before.filter((entry) => entry.startsWith('finish'))).toHaveLength(MAX_CONCURRENT);
  });

  it('waits for the last, part-full batch before returning', async () => {
    await handler(insertEvent('o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'), contextWith(900_000));

    // The invocation returning is what releases the next batch of records, so
    // nothing may still be holding a slot by the time it does.
    expect(instance.running.size).toBe(0);
    expect(instance.log.filter((entry) => entry.startsWith('finish'))).toHaveLength(7);
  });

  it('waits for a slot rather than failing when Connect says it is full', async () => {
    refuseOnce.add('test-case-1');

    const result = await handler(insertEvent('o1'), contextWith(900_000));

    expect(starts()).toEqual(['start:execution-1']);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('hands back the records it has no time left to batch', async () => {
    // Enough of the clock for the batch it has started, not enough for another.
    const result = await handler(
      insertEvent('o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'),
      contextWith(600_000)
    );

    expect(starts()).toHaveLength(MAX_CONCURRENT);
    expect(result).toEqual({
      batchItemFailures: [{ itemIdentifier: 'seq-6' }, { itemIdentifier: 'seq-7' }],
    });
  });

  it('does not spend a slot on a flow being removed', async () => {
    const event = insertEvent('o1', 'o2', 'o3', 'o4', 'o5');
    event.Records.unshift(removeRecord('gone', 'seq-0'));

    const result = await handler(event, contextWith(900_000));

    // The delete costs no execution, so all five inserts still fit one batch.
    expect(starts()).toHaveLength(MAX_CONCURRENT);
    expect(instance.peak).toBe(MAX_CONCURRENT);
    expect(result).toEqual({ batchItemFailures: [] });
  });
});

// One item Connect will not accept used to take the whole stream batch with it: the
// create threw, the batch was reported as failed, and every record beside it was
// delivered again and its test case run a second time. A real upload lost a test case
// to exactly that - CreateTestCase answered 400 InvalidTestCaseException for a path
// that had nothing to assert but the block the flow ended on.
describe('a test case whose content Connect refuses', () => {
  it('is skipped, and says which observation Connect objected to', async () => {
    const reported: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      reported.push(args.map(String).join(' '));
    });
    refuseContentFor = new Set([`${FLOW_NAME}:o1`]);

    const result = await handler(insertEvent('o1'), contextWith(900_000));

    // Nothing was started, and nothing is left for the stream to redeliver: there is
    // no answer that would make this content acceptable next time.
    expect(starts()).toEqual([]);
    expect(result).toEqual({ batchItemFailures: [] });
    // Connect's own reason, which names the block to go and give a prompt to.
    expect(reported.join('\n')).toContain('observationIdentifier=flow_ended');
    expect(reported.join('\n')).toContain(`${FLOW_NAME}:o1`);
  });

  it('leaves the rest of the batch to run', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    refuseContentFor = new Set([`${FLOW_NAME}:o2`]);

    const result = await handler(insertEvent('o1', 'o2', 'o3'), contextWith(900_000));

    expect(starts()).toHaveLength(2);
    expect(result).toEqual({ batchItemFailures: [] });
  });

  it('still lets an error that would be worth retrying fail the record', async () => {
    // A full instance is the other kind of refusal: the same content would be taken
    // later, so that record is handed back for the stream to redeliver.
    refuseOnce = new Set(['test-case-1']);
    pollsToFinish = 1;

    const result = await handler(insertEvent('o1'), contextWith(900_000));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(starts()).toHaveLength(1);
  });

  it('waits for the welcome message on a path that does play something', async () => {
    await handler(insertEvent('o1'), contextWith(900_000));

    const [initiated, welcome] = createdContent[0].Observations as any[];
    expect(initiated.Transitions).toEqual({ NextObservations: ['welcome_message'] });
    expect(welcome.Event.Type).toBe('MessageReceived');
  });

  it('still overrides the hours check, which every test case does', async () => {
    await handler(insertEvent('o1'), contextWith(900_000));

    expect(
      (createdContent[0].Observations[0].Actions as any[])
        .filter((action) => action.Type === 'OverrideSystemBehavior')
        .map((action) => action.Parameters.Behavior.Properties.ActionType)
    ).toEqual(['CheckHoursOfOperation']);
  });
});

// A Lambda block is not overridden at all: the execution invokes the real function,
// so what the flow branches on is what that function answers. Everything the test
// case does is on one side of that - the prompts it asserts and the hours it fixes.
describe('what the execution overrides', () => {
  const ARN = 'arn:aws:lambda:af-south-1:123456789012:function:lookup-customer';

  /** Every OverrideSystemBehavior in the test case, by the action it overrides. */
  const overrides = (content: any) =>
    (content.Observations[0].Actions as any[])
      .filter((action) => action.Type === 'OverrideSystemBehavior')
      .map((action) => action.Parameters.Behavior.Properties);

  it('overrides the hours check and leaves the invocation alone', async () => {
    await handler(insertEvent('o1'), contextWith(900_000));

    expect(overrides(createdContent[0])).toEqual([
      expect.objectContaining({ ActionType: 'CheckHoursOfOperation' }),
    ]);
  });

  it('ignores a lambda_mocks an earlier upload left on the item', async () => {
    // Items written while invocations were mocked are still in the table, and are
    // read no differently: the key is known, so it is not mistaken for a block, and
    // nothing acts on it.
    legacyLambdaMocks = [{ arn: ARN, response: { customerType: 'gold', balance: 'R1 250.00' } }];

    await handler(insertEvent('o1'), contextWith(900_000));

    expect(overrides(createdContent[0])).toEqual([
      expect.objectContaining({ ActionType: 'CheckHoursOfOperation' }),
    ]);
    // And the rest of the item still comes through, rather than the entry breaking it.
    expect((createdContent[0].Observations[1] as any).Event.Type).toBe('MessageReceived');
  });

  it('sends a message the item lays out over several lines as one line', async () => {
    // Connect matches the sentence, not the layout, so an item carrying the line
    // breaks - hand-written, or written before generation collapsed them - goes up
    // without them rather than never matching the prompt.
    configBlocks = {
      welcome_message: {
        M: { Observe: { M: { message: { S: 'Press one for sales.\nPress two for support.' } } } },
      },
    };

    await handler(insertEvent('o1'), contextWith(900_000));

    const [, welcome] = createdContent[0].Observations as any[];
    expect(welcome.Event.Properties.Text).toBe('Press one for sales. Press two for support.');
  });

  it('draws the one override on its own in the settings cluster', async () => {
    await handler(insertEvent('o1'), contextWith(900_000));

    const content = createdContent[0];
    const metadata = content.Metadata.ActionMetadata;
    const [hooId] = (content.Observations[0].Actions as any[])
      .filter((action) => action.Type === 'OverrideSystemBehavior')
      .map((action) => action.Identifier);

    // The console nests extra overrides under the first one. There are none, so it
    // has no children, and the cluster still holds the two steps of the interaction.
    expect(metadata[hooId].children).toBeUndefined();
    expect(content.Metadata.Annotations[0].clusterProfile.actionIds).toEqual([
      content.Observations[0].Event.Identifier,
      hooId,
    ]);
  });
});

// The config names the flow, the test case needs its id, and ListContactFlows hands
// the instance's flows out a page at a time.
describe('finding the flow the config names', () => {
  const OTHER = { Name: 'BM-Other-Flow', Id: 'c0a1e2d3-0000-4000-8000-000000000009' };

  const listCalls = () =>
    connectSend.mock.calls.filter(([command]) => command instanceof ListContactFlowsCommand).length;

  /** What each created test case dials, which is where the looked-up id ends up. */
  const dialled = () =>
    connectSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof CreateTestCaseCommand)
      .map((command: any) => command.input.EntryPoint.VoiceCallEntryPointParameters);

  const phoneNumberEvent = (): DynamoDBStreamEvent => ({
    Records: [
      {
        eventName: 'INSERT',
        dynamodb: {
          SequenceNumber: 'seq-1',
          ApproximateCreationDateTime: 1_700_000_000,
          Keys: { 'flow-name': { S: '+27110000000' }, 'testing-option': { S: 'o1' } },
        },
      },
    ] as DynamoDBRecord[],
  });

  it('finds a flow that is not on the first page', async () => {
    flowPages = [[OTHER], [OTHER], [{ Name: FLOW_NAME, Id: FLOW_ID }]];

    await handler(insertEvent('o1'), contextWith(900_000));

    expect(dialled()).toEqual([{ SourcePhoneNumber: '+27100000000', FlowId: FLOW_ID }]);
    expect(listCalls()).toBe(3);
  });

  it('reads every page before saying the flow is not there', async () => {
    flowPages = [[OTHER], [OTHER]];

    await expect(handler(insertEvent('o1'), contextWith(900_000))).rejects.toThrow(
      `No contact flow found matching name: ${FLOW_NAME}`
    );
    expect(listCalls()).toBe(2);
  });

  it('lists the flows once for a whole batch, not once per test case', async () => {
    flowPages = [[OTHER], [{ Name: FLOW_NAME, Id: FLOW_ID }]];

    await handler(insertEvent('o1', 'o2', 'o3'), contextWith(900_000));

    expect(dialled()).toHaveLength(3);
    expect(listCalls()).toBe(2);
  });

  it('lists nothing when the config names a number to dial instead of a flow', async () => {
    await handler(phoneNumberEvent(), contextWith(900_000));

    expect(dialled()).toEqual([
      { DestinationPhoneNumber: '+27110000000', SourcePhoneNumber: '+27100000000' },
    ]);
    expect(listCalls()).toBe(0);
  });

  it('takes a name differing only in case, once no page has held the exact one', async () => {
    flowPages = [[{ Name: FLOW_NAME.toLowerCase(), Id: FLOW_ID }], [OTHER]];

    await handler(insertEvent('o1'), contextWith(900_000));

    expect(dialled()).toEqual([{ SourcePhoneNumber: '+27100000000', FlowId: FLOW_ID }]);
    expect(listCalls()).toBe(2);
  });
});

// A stream record is history: by the time it is read, the item it names may have
// been deleted - a definition removed, or a re-upload whose options are named
// differently from the ones it replaced. Failing on it would fail the batch, and
// the event source retries a failed batch fifteen times over, so every test case
// behind it on the shard waits for a record that can never succeed.
describe('a record whose config item has since been deleted', () => {
  const created = () =>
    connectSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof CreateTestCaseCommand)
      .map((command: any) => command.input.Description);

  it('hands the batch back as done rather than failing it', async () => {
    deletedOptions.add('o1');

    const result = await handler(insertEvent('o1'), contextWith(900_000));

    expect(result).toEqual({ batchItemFailures: [] });
    expect(created()).toEqual([]);
    expect(starts()).toEqual([]);
  });

  it('runs the records around it', async () => {
    deletedOptions.add('o2');

    await handler(insertEvent('o1', 'o2', 'o3'), contextWith(900_000));

    expect(created()).toEqual([`${FLOW_NAME} o1`, `${FLOW_NAME} o3`]);
    expect(starts()).toHaveLength(2);
  });

  it('says which option it was, so a deleted one can be told from a broken one', async () => {
    const logged: string[] = [];
    (console.log as jest.Mock).mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
    deletedOptions.add('o1');

    await handler(insertEvent('o1'), contextWith(900_000));

    expect(logged.join('\n')).toContain(`No config item for ${FLOW_NAME} / o1`);
  });

  it('still leaves a full batch of five running when one of six is gone', async () => {
    deletedOptions.add('o1');

    await handler(insertEvent('o1', 'o2', 'o3', 'o4', 'o5', 'o6'), contextWith(900_000));

    // The five that are left run together rather than four and then one: a skipped
    // record takes no slot in the batch.
    expect(starts()).toHaveLength(5);
    expect(instance.peak).toBe(MAX_CONCURRENT);
  });
});
