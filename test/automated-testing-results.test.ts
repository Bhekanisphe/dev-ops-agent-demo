// Where a test case execution's result ends up. Two workbooks now: the combined
// one at the root of the bucket, and the flow's own under test-case-results/,
// named after the flow it holds the results of.
//
// S3, Connect and DynamoDB are fakes holding the state a real bucket, instance
// and table would; ExcelJS is the real thing, so what comes back out of the
// bucket is a workbook that actually parses.

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  const send = jest.fn();
  return { ...actual, S3Client: jest.fn(() => ({ send })), __send: send };
});

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
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  DescribeContactFlowCommand,
  DescribeHoursOfOperationCommand,
  DescribeQueueCommand,
  GetTestCaseExecutionSummaryCommand,
  ListTestCaseExecutionRecordsCommand,
} from '@aws-sdk/client-connect';
import { DeleteItemCommand, GetItemCommand } from '@aws-sdk/client-dynamodb';
import ExcelJS from 'exceljs';
import type { Context, DynamoDBStreamEvent } from 'aws-lambda';

const { __send: s3Send } = jest.requireMock('@aws-sdk/client-s3') as { __send: jest.Mock };
const { __send: connectSend } = jest.requireMock('@aws-sdk/client-connect') as {
  __send: jest.Mock;
};
const { __send: dynamoSend } = jest.requireMock('@aws-sdk/client-dynamodb') as {
  __send: jest.Mock;
};

const BUCKET = 'rsa-automated-test-cases-results';
const OBJECT_NAME = 'test-execution-results.xlsx';
const RESULTS_PREFIX = 'test-case-results/';

process.env.INSTANCE_ID = '6e669f6f-3783-4c0e-ac76-4f531575015d';
process.env.KEY_NAME = 'test-case-id';
process.env.SORT_NAME = 'execution-id';
process.env.RESULTS_BUCKET = BUCKET;
process.env.OBJECT_NAME = OBJECT_NAME;
process.env.RESULTS_PREFIX = RESULTS_PREFIX;
process.env.RESULTS_TABLE_NAME = 'rsa-test-results-cdk';

// Imported after the environment is set: the bucket, the prefix and the object
// name are read once, when the module loads, exactly as they are in Lambda.
const { handler, flow_results_key, load_results_sheet } = require('../lambda/automated-testing-results') as {
  handler: (
    event: DynamoDBStreamEvent,
    context?: Context
  ) => Promise<{ batchItemFailures: { itemIdentifier: string }[] }>;
  flow_results_key: (flow: string) => string;
  load_results_sheet: (key: string) => Promise<{ worksheet: ExcelJS.Worksheet; etag?: string }>;
};

/** An object in the bucket: its bytes and the version of them. */
interface StoredObject {
  body: Buffer;
  etag: string;
}

// The bucket's objects, by key.
let objects: Map<string, StoredObject>;
// The results table's items, by "<test case>/<execution>", each removed once written.
let items: Set<string>;
let flowName: string;
let queueName: string;
// What the summary call says an execution is doing, by execution id; PASSED unless said otherwise.
let executionStatuses: Map<string, string>;
// When the summary call says the execution started, as Connect reports it: UTC.
let startedAt: Date | undefined;
// The records the execution produced, so a test can hand back an awkward shape.
let executionRecordsFor: () => any;
// Called just before a conditional write lands, for a test that needs another writer to get in first.
let beforePut: ((key: string) => Promise<void>) | undefined;

let etagCounter = 0;
const nextEtag = () => `"etag-${++etagCounter}"`;

// Each execution in a test gets its own id, the way two runs of the same test case do.
let executionCounter = 0;

const notFound = () => {
  const error: any = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const preconditionFailed = () => {
  const error: any = new Error('At least one of the pre-conditions you specified did not hold.');
  error.name = 'PreconditionFailed';
  error.$metadata = { httpStatusCode: 412 };
  return error;
};

const bodyOf = (key: string): Buffer => objects.get(key)!.body;

beforeEach(() => {
  objects = new Map<string, StoredObject>();
  items = new Set<string>();
  flowName = 'BM-Test-IaC-Flow';
  queueName = 'BM-Test-Sales-IaC';
  executionStatuses = new Map<string, string>();
  startedAt = new Date('2026-09-04T09:32:15Z');
  executionRecordsFor = executionRecords;
  beforePut = undefined;
  executionCounter = 0;

  s3Send.mockReset();
  s3Send.mockImplementation(async (command: any) => {
    // Sorted and truncated the way S3 does it, so a one-key listing of an exact
    // key only comes back with that key when it is really there.
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? '';
      const matching = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const limit = command.input.MaxKeys ?? matching.length;
      return { Contents: matching.slice(0, limit).map((Key) => ({ Key })) };
    }
    if (command instanceof GetObjectCommand) {
      const stored = objects.get(command.input.Key as string);
      if (!stored) throw notFound();
      return { Body: [stored.body], ETag: stored.etag };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key as string;
      if (beforePut) await beforePut(key);

      // The conditions S3 itself enforces: write over the version that was read,
      // and no other; or, having read none, be the write that creates the object.
      const stored = objects.get(key);
      if (command.input.IfNoneMatch === '*' && stored) throw preconditionFailed();
      if (command.input.IfMatch && stored?.etag !== command.input.IfMatch) {
        throw preconditionFailed();
      }

      objects.set(key, { body: Buffer.from(command.input.Body as Buffer), etag: nextEtag() });
      return {};
    }
    throw new Error(`unexpected S3 command ${command.constructor.name}`);
  });

  connectSend.mockReset();
  connectSend.mockImplementation(async (command: any) => {
    if (command instanceof GetTestCaseExecutionSummaryCommand) {
      return {
        Status: executionStatuses.get(command.input.TestCaseExecutionId ?? '') ?? 'PASSED',
        StartTime: startedAt,
      };
    }
    if (command instanceof ListTestCaseExecutionRecordsCommand) return executionRecordsFor();
    if (command instanceof DescribeHoursOfOperationCommand) {
      return { HoursOfOperation: { Name: 'BasicHours' } };
    }
    if (command instanceof DescribeQueueCommand) return { Queue: { Name: queueName } };
    if (command instanceof DescribeContactFlowCommand) {
      return { ContactFlow: { Name: flowName } };
    }
    throw new Error(`unexpected Connect command ${command.constructor.name}`);
  });

  dynamoSend.mockReset();
  dynamoSend.mockImplementation(async (command: any) => {
    const key = command.input?.Key;
    const id = key ? `${key['test-case-id'].S}/${key['execution-id'].S}` : '';

    // An item stands for a result not yet written, and is gone once it has been.
    if (command instanceof GetItemCommand) {
      return items.has(id) ? { Item: { ...key } } : {};
    }
    if (command instanceof DeleteItemCommand) {
      items.delete(id);
      return {};
    }
    return {};
  });
});

// One execution's records, in the shape Connect returns them: the plain
// lifecycle records, then the ones carrying Actions.
const executionRecords = () => ({
  ExecutionRecords: [
    {
      Status: 'PASSED',
      Record: JSON.stringify({
        Type: 'INITIATION',
        EntryPoint: { Parameters: { FlowId: 'aaaaaaaa-1111-2222-3333-444444444444' } },
      }),
    },
    {
      Status: 'PASSED',
      Record: JSON.stringify({
        Type: 'EXECUTION_START',
        ContactId: 'cccccccc-1111-2222-3333-444444444444',
        EntryPoint: { Parameters: { SourcePhoneNumber: '+1234567890' } },
      }),
    },
    {
      Status: 'PASSED',
      Record: JSON.stringify({
        Event: { Type: 'TestInitiated' },
        Actions: [
          {
            ExpectedParameters: {
              Behavior: {
                Properties: {
                  ActionParameters: { HoursOfOperationId: 'hoo-1' },
                  Strategy: { Response: { ExecutionResult: { Value: 'InHour' } } },
                },
              },
            },
          },
        ],
      }),
    },
    {
      Status: 'PASSED',
      Record: JSON.stringify({
        Status: 'PASSED',
        Identifier: 'welcome_message',
        Event: { Type: 'MessageReceived', Properties: { Text: 'Welcome', ExpectedText: 'Welcome' } },
        Actions: [{ ActualParameters: { Instruction: { Properties: { Value: '2' } } } }],
      }),
    },
    {
      Status: 'PASSED',
      Record: JSON.stringify({
        Status: 'PASSED',
        Event: {
          Type: 'FlowActionStarted',
          Properties: { ActionParameters: { QueueId: 'queue-1' } },
        },
        Actions: [],
      }),
    },
    {
      Status: 'PASSED',
      Record: JSON.stringify({
        Type: 'COMPLETION',
        CompletionReason: { Type: 'SUCCESS', Message: 'Test case passed' },
      }),
    },
  ],
});

// One stream record per test case name, each its own execution with its own item on
// the results table, as a real batch of concurrently started executions arrives.
const insertEvent = (...testCaseNames: string[]): DynamoDBStreamEvent => {
  const records = testCaseNames.map((testCaseName) => {
    const n = ++executionCounter;
    const execution_id = `ex-${n}`;
    items.add(`tc-1/${execution_id}`);
    return {
      eventName: 'INSERT',
      dynamodb: {
        SequenceNumber: `seq-${n}`,
        Keys: {
          'test-case-id': { S: 'tc-1' },
          'execution-id': { S: execution_id },
        },
        NewImage: { Test_case_name: { S: testCaseName } },
      },
    };
  });

  return { Records: records } as unknown as DynamoDBStreamEvent;
};

/** A batch that has as long as it needs, or none at all. */
const contextWith = (remaining: number) =>
  ({ getRemainingTimeInMillis: () => remaining } as unknown as Context);

// A cell as text, rich text included: the steps cell is written as runs so that the
// labels in it can be bold, and what it says is still one string.
const textOf = (value: ExcelJS.CellValue): string => {
  const rich = (value as ExcelJS.CellRichTextValue)?.richText;
  if (rich) return rich.map((run) => run.text).join('');
  return String(value ?? '');
};

// What ended up in a workbook: every row after the headings, column by column.
const rowsIn = async (key: string): Promise<string[][]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bodyOf(key) as any);
  const worksheet = workbook.worksheets[0];
  const rows: string[][] = [];

  worksheet.eachRow((row, number) => {
    if (number === 1) return;
    const values: string[] = [];
    for (let column = 1; column <= 10; column++) {
      values.push(textOf(row.getCell(column).value));
    }
    rows.push(values);
  });

  return rows;
};

// The runs of the steps cell of the first result row, so a test can say which of
// them are bold rather than only what the cell reads as.
const stepRunsIn = async (key: string): Promise<ExcelJS.RichText[]> => {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bodyOf(key) as any);
  const value = workbook.worksheets[0].getRow(2).getCell(5).value;
  return (value as ExcelJS.CellRichTextValue).richText;
};

describe('a workbook named after the flow', () => {
  it('names it after the flow it holds the results of', () => {
    expect(flow_results_key('BM-Test-IaC-Flow')).toBe('test-case-results/BM-Test-IaC-Flow.xlsx');
  });

  it('keeps a flow name that cannot be a file name out of the key', () => {
    // A "/" would turn the flow name into a folder, splitting one flow's results
    // over two names that read the same in the console. A space comes back from an
    // S3 event as "+", which is its own confusion.
    expect(flow_results_key('Sales / Support')).toBe('test-case-results/Sales-Support.xlsx');
    expect(flow_results_key('  ')).toBe('test-case-results/unknown-flow.xlsx');
    // A flow tested by number rather than by id keeps the number.
    expect(flow_results_key('+27123456789')).toBe('test-case-results/+27123456789.xlsx');
  });

  it('creates one on the first run, since it cannot exist yet', async () => {
    const { worksheet, etag } = await load_results_sheet('test-case-results/BM-Test-IaC-Flow.xlsx');

    // The headings, and nothing else to append after.
    expect(worksheet.getRow(1).getCell(1).value).toBe('Flow/Number');
    expect(worksheet.actualRowCount).toBe(1);
    // No version read, because there was nothing to read: the write has to be the
    // one that creates the workbook.
    expect(etag).toBeUndefined();
    // Asked with a listing, so a key that has never existed answers the question
    // rather than failing it: without s3:ListBucket, S3 calls that 403.
    expect(s3Send).toHaveBeenCalledTimes(1);
    expect(s3Send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
  });
});

describe('writing an execution result', () => {
  it('writes the same row to the combined workbook and to the flow’s own', async () => {
    await handler(insertEvent('BM-Test-IaC-Flow:2'));

    expect([...objects.keys()].sort()).toEqual([
      'test-case-results/BM-Test-IaC-Flow.xlsx',
      'test-execution-results.xlsx',
    ]);

    for (const key of objects.keys()) {
      const rows = await rowsIn(key);
      expect(rows).toHaveLength(1);
      const [flow, option, hours, hoursResult, steps, result, comment, queue, contact, executed] =
        rows[0];
      expect(flow).toBe('BM-Test-IaC-Flow');
      // The testing option, which is the half of the test case name after the colon.
      expect(option).toBe('2');
      expect(hours).toBe('BasicHours');
      expect(hoursResult).toBe('InHour');
      expect(steps).toContain('welcome_message [PASSED]');
      expect(steps).toContain('Customer input: 2');
      expect(result).toBe('SUCCESS');
      expect(comment).toBe('Test case passed');
      expect(queue).toBe('[PASSED] - Transferred to BM-Test-Sales-IaC');
      expect(contact).toBe('cccccccc-1111-2222-3333-444444444444');
      // Connect timestamps the execution in UTC; the report reads it in the
      // instance's own time, which is two hours ahead all year.
      expect(executed).toBe('2026-09-04 11:32:15');
    }
  });

  it('gives the workbook a heading for when the execution ran', async () => {
    const { worksheet } = await load_results_sheet('test-case-results/BM-Test-IaC-Flow.xlsx');

    expect(worksheet.getRow(1).getCell(10).value).toBe('Executed at (SAST)');
  });

  it('says so rather than guessing when the execution has no start time', async () => {
    startedAt = undefined;

    await handler(insertEvent('BM-Test-IaC-Flow:2'));

    expect((await rowsIn(OBJECT_NAME))[0][9]).toBe('N/A');
  });

  it('lays the test steps out a step to a block, with the labels bold', async () => {
    await handler(insertEvent('BM-Test-IaC-Flow:2'));

    const runs = await stepRunsIn('test-case-results/BM-Test-IaC-Flow.xlsx');

    // One line per thing said about the step, each behind its own label, so the
    // prompt text is not a wall to read the labels out of.
    expect(runs.map((run) => run.text).join('')).toBe(
      'welcome_message [PASSED]' +
        '\n    Received: Welcome' +
        '\n    Expected: Welcome' +
        '\n    Customer input: 2'
    );

    const bold = runs.filter((run) => run.font?.bold).map((run) => run.text);
    expect(bold).toEqual([
      'welcome_message',
      '\n    Received: ',
      '\n    Expected: ',
      '\n    Customer input: ',
    ]);
    // And the prompt text itself is not: bolding all of it bolds nothing.
    expect(runs.filter((run) => !run.font?.bold).map((run) => run.text)).toContain('Welcome');
  });

  it('appends to the flow’s workbook rather than starting it again', async () => {
    await handler(insertEvent('BM-Test-IaC-Flow:2'));
    await handler(insertEvent('BM-Test-IaC-Flow:3'));

    const rows = await rowsIn('test-case-results/BM-Test-IaC-Flow.xlsx');
    expect(rows.map((row) => row[1])).toEqual(['2', '3']);
    // The combined workbook holds both flows' runs, so it grows the same way.
    expect(await rowsIn(OBJECT_NAME)).toHaveLength(2);
  });

  it('keeps each flow’s results in its own workbook', async () => {
    await handler(insertEvent('BM-Test-IaC-Flow:2'));

    flowName = 'BM-Test-Voice-IaC-Flow';
    queueName = 'BM-Test-Technical-Wifi-IaC';
    await handler(insertEvent('BM-Test-Voice-IaC-Flow:bs-sales'));

    expect([...objects.keys()].sort()).toEqual([
      'test-case-results/BM-Test-IaC-Flow.xlsx',
      'test-case-results/BM-Test-Voice-IaC-Flow.xlsx',
      'test-execution-results.xlsx',
    ]);
    // One row each, and the combined workbook has both.
    expect(await rowsIn('test-case-results/BM-Test-IaC-Flow.xlsx')).toHaveLength(1);
    expect(await rowsIn('test-case-results/BM-Test-Voice-IaC-Flow.xlsx')).toHaveLength(1);
    expect((await rowsIn(OBJECT_NAME)).map((row) => row[0])).toEqual([
      'BM-Test-IaC-Flow',
      'BM-Test-Voice-IaC-Flow',
    ]);
  });

  it('clears the item off the results table once both workbooks have the row', async () => {
    await handler(insertEvent('BM-Test-IaC-Flow:2'));

    const deletes = dynamoSend.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteItemCommand);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].input.Key).toEqual({
      'test-case-id': { S: 'tc-1' },
      'execution-id': { S: 'ex-1' },
    });
  });

  it('writes a result whose last observation only ends the test', async () => {
    // The out-of-hours message is the end of that path, so the only action on it is
    // the one that ends the test - which carries no instruction. Reading one out of
    // it anyway used to throw, and the throw took the whole batch of results with it.
    executionRecordsFor = () => ({
      ExecutionRecords: [
        {
          Status: 'PASSED',
          Record: JSON.stringify({
            Type: 'INITIATION',
            EntryPoint: { Parameters: { FlowId: 'aaaaaaaa-1111-2222-3333-444444444444' } },
          }),
        },
        {
          Status: 'PASSED',
          Record: JSON.stringify({
            Status: 'PASSED',
            Identifier: 'closed_message',
            Event: {
              Type: 'MessageReceived',
              Properties: { Text: 'We are closed', ExpectedText: 'We are closed' },
            },
            Actions: [{ Type: 'TestControl' }],
          }),
        },
        {
          Status: 'PASSED',
          Record: JSON.stringify({
            Type: 'COMPLETION',
            CompletionReason: { Type: 'SUCCESS', Message: 'Test case passed' },
          }),
        },
      ],
    });

    const failures = await handler(insertEvent('BM-Test-IaC-Flow:2'));

    expect(failures.batchItemFailures).toEqual([]);
    const rows = await rowsIn('test-case-results/BM-Test-IaC-Flow.xlsx');
    expect(rows).toHaveLength(1);
    expect(rows[0][4]).toContain('closed_message [PASSED]');
    // Nothing was pressed, and nothing claims otherwise.
    expect(rows[0][4]).not.toContain('Customer input');
    // A path that never reaches a queue says so rather than inventing one.
    expect(rows[0][7]).toBe('N/A');
  });
});

describe('a result that cannot be written yet', () => {
  it('hands back the records it could not finish and keeps the ones it did', async () => {
    const event = insertEvent('BM-Test-IaC-Flow:2', 'BM-Test-IaC-Flow:3');
    const running_id = (event.Records[1].dynamodb!.Keys as any)['execution-id'].S;
    executionStatuses.set(running_id, 'IN_PROGRESS');

    // Out of time the moment it starts, as an invocation that has spent its fifteen
    // minutes waiting on a ten minute execution is.
    const failures = await handler(event, contextWith(0));

    // Only the unfinished one comes back, so the shard carries on from it rather
    // than rewinding over the row that is already written.
    expect(failures.batchItemFailures).toEqual([{ itemIdentifier: 'seq-2' }]);
    expect(await rowsIn('test-case-results/BM-Test-IaC-Flow.xlsx')).toHaveLength(1);
    expect(items.has('tc-1/ex-1')).toBe(false);
    expect(items.has('tc-1/ex-2')).toBe(true);
  });

  it('writes the row once when the same record is delivered again', async () => {
    const event = insertEvent('BM-Test-IaC-Flow:2');

    await handler(event);
    await handler(event);

    // The item is gone after the first write, and a record whose item has gone is a
    // record whose row is already there.
    expect(await rowsIn('test-case-results/BM-Test-IaC-Flow.xlsx')).toHaveLength(1);
    expect(await rowsIn(OBJECT_NAME)).toHaveLength(1);
  });

  it('re-reads the workbook when another result writes it first', async () => {
    const flowKey = 'test-case-results/BM-Test-IaC-Flow.xlsx';

    // Another execution's result lands in the moment between this one reading the
    // workbook and writing it back. Written blindly, this row would take that one
    // with it; the write is refused instead, and the row is appended to what is
    // really there.
    beforePut = async (key) => {
      if (key !== flowKey) return;
      beforePut = undefined;
      await handler(insertEvent('BM-Test-IaC-Flow:9'));
    };

    const failures = await handler(insertEvent('BM-Test-IaC-Flow:2'));

    expect(failures.batchItemFailures).toEqual([]);
    const rows = await rowsIn(flowKey);
    expect(rows.map((row) => row[1])).toEqual(['9', '2']);
  });
});
