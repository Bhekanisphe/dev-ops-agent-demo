// What deleting a flow definition tears down. The generator is the only thing
// that knows a definition is gone, so this is where the promise "delete the JSON
// and the flow's test cases go with it" is either kept or quietly broken - and
// nothing about it is visible from the pure functions the other suite covers.
//
// The S3 and Connect clients are stood up as fakes holding the state a real
// bucket and instance would: which keys exist, and which test cases do.

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

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  DeleteTestCaseCommand,
  ListTestCasesCommand,
} from '@aws-sdk/client-connect';
import type { S3Event } from 'aws-lambda';

const { __send: s3Send } = jest.requireMock('@aws-sdk/client-s3') as { __send: jest.Mock };
const { __send: connectSend } = jest.requireMock('@aws-sdk/client-connect') as {
  __send: jest.Mock;
};

const INSTANCE_ID = '6e669f6f-3783-4c0e-ac76-4f531575015d';
const BUCKET = 'rsa-automated-test-cases-results';

process.env.INSTANCE_ID = INSTANCE_ID;
process.env.REGION = 'af-south-1';
process.env.DEFAULT_CALLER_NUMBER = '+1234567890';

// Imported after the environment is set: the prefixes and the instance id are
// read once, when the module loads, exactly as they are in Lambda.
const { handler } = require('../lambda/flow-test-cases-gen') as {
  handler: (event: S3Event, context: any) => Promise<Record<string, unknown>>;
};

interface TestCase {
  Id: string;
  Name: string;
}

// The bucket's keys and the instance's test cases, as the fakes see them.
let keys: Set<string>;
let testCases: TestCase[];
let deleted: { keys: string[]; testCaseIds: string[] };
// Test cases that vanish between being listed and being deleted, which is what a
// concurrent teardown looks like from here.
let alreadyGone: Set<string>;

const resourceNotFound = () => {
  const error: any = new Error('The test case was not found');
  error.name = 'ResourceNotFoundException';
  return error;
};

// One page at a time, so a flow with more test cases than a page holds is not
// half-deleted.
const PAGE_SIZE = 2;

beforeEach(() => {
  keys = new Set<string>();
  testCases = [];
  deleted = { keys: [], testCaseIds: [] };
  alreadyGone = new Set<string>();

  s3Send.mockReset();
  s3Send.mockImplementation(async (command: any) => {
    // Sorted and truncated the way S3 does it, so a one-key listing of an exact
    // key only comes back with that key when it is really there.
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? '';
      const matching = [...keys].filter((key) => key.startsWith(prefix)).sort();
      const limit = command.input.MaxKeys ?? matching.length;
      return { Contents: matching.slice(0, limit).map((Key) => ({ Key })) };
    }
    if (command instanceof DeleteObjectCommand) {
      const key = command.input.Key as string;
      keys.delete(key);
      deleted.keys.push(key);
      return {};
    }
    throw new Error(`unexpected S3 command ${command.constructor.name}`);
  });

  connectSend.mockReset();
  connectSend.mockImplementation(async (command: any) => {
    if (command instanceof ListTestCasesCommand) {
      expect(command.input.InstanceId).toBe(INSTANCE_ID);
      const start = command.input.NextToken ? Number(command.input.NextToken) : 0;
      const page = testCases.slice(start, start + PAGE_SIZE);
      const next = start + PAGE_SIZE;
      return {
        TestCaseSummaryList: page,
        NextToken: next < testCases.length ? String(next) : undefined,
      };
    }
    if (command instanceof DeleteTestCaseCommand) {
      const id = command.input.TestCaseId as string;
      if (alreadyGone.has(id)) throw resourceNotFound();
      testCases = testCases.filter((testCase) => testCase.Id !== id);
      deleted.testCaseIds.push(id);
      return {};
    }
    throw new Error(`unexpected Connect command ${command.constructor.name}`);
  });
});

const removalEvent = (key: string): S3Event =>
  ({
    Records: [
      {
        eventName: 'ObjectRemoved:DeleteMarkerCreated',
        s3: { bucket: { name: BUCKET }, object: { key } },
      },
    ],
  } as unknown as S3Event);

const run = (key: string) => handler(removalEvent(key), { functionName: 'test' });

describe('deleting a flow definition', () => {
  it('deletes the generated config and every test case named after the flow', async () => {
    keys.add('flow-definition/BM-Test-IaC-Flow.json');
    keys.add('test-case-data/BM-Test-IaC-Flow.json');
    testCases = [
      { Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' },
      { Id: 'tc-2', Name: 'BM-Test-IaC-Flow:2' },
      { Id: 'tc-3', Name: 'BM-Test-IaC-Flow:OutOfHour' },
    ];
    // The definition is gone by the time the event arrives.
    keys.delete('flow-definition/BM-Test-IaC-Flow.json');

    const result = await run('flow-definition/BM-Test-IaC-Flow.json');

    expect(deleted.keys).toEqual(['test-case-data/BM-Test-IaC-Flow.json']);
    expect(deleted.testCaseIds.sort()).toEqual(['tc-1', 'tc-2', 'tc-3']);
    expect(testCases).toEqual([]);
    expect(result).toMatchObject({
      statusCode: 200,
      configs_removed: 1,
      test_cases_deleted: 3,
      test_cases_generated: 0,
    });
  });

  it('leaves another flow’s test cases alone', async () => {
    keys.add('test-case-data/BM-Test-IaC-Flow.json');
    testCases = [
      { Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' },
      // Neither of these is this flow's: one is a longer flow name that merely
      // starts the same way, the other a different flow entirely.
      { Id: 'tc-2', Name: 'BM-Test-IaC-Flow-Copy:1.1' },
      { Id: 'tc-3', Name: 'BM-Test-Voice-IaC-Flow:bs-sales' },
    ];

    await run('flow-definition/BM-Test-IaC-Flow.json');

    expect(deleted.testCaseIds).toEqual(['tc-1']);
    expect(testCases.map((testCase) => testCase.Id)).toEqual(['tc-2', 'tc-3']);
  });

  it('keeps everything when the definition still exists', async () => {
    // The bucket is versioned, so ObjectRemoved also fires when a noncurrent
    // version is purged. The definition is still live and still owns its config.
    keys.add('flow-definition/BM-Test-IaC-Flow.json');
    keys.add('test-case-data/BM-Test-IaC-Flow.json');
    testCases = [{ Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' }];

    const result = await run('flow-definition/BM-Test-IaC-Flow.json');

    expect(deleted).toEqual({ keys: [], testCaseIds: [] });
    expect(connectSend).not.toHaveBeenCalled();
    expect(result).toMatchObject({ configs_removed: 0, test_cases_deleted: 0 });
  });

  it('deletes the test cases even with no generated config left to delete', async () => {
    // A config deleted by hand, or a generation that failed after the test cases
    // were created. The test cases are what actually run, so they are what has to
    // go - the config's absence is not a reason to leave them behind.
    testCases = [{ Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' }];

    const result = await run('flow-definition/BM-Test-IaC-Flow.json');

    expect(deleted.keys).toEqual([]);
    expect(deleted.testCaseIds).toEqual(['tc-1']);
    expect(result).toMatchObject({ configs_removed: 0, test_cases_deleted: 1 });
  });

  it('works through every page of test cases', async () => {
    // Deleting by name means listing the whole instance, which pages. Stopping at
    // the first page would leave the rest of the flow's test cases running.
    testCases = Array.from({ length: PAGE_SIZE * 3 + 1 }, (_, i) => ({
      Id: `tc-${i}`,
      Name: `BM-Test-IaC-Flow:${i}`,
    }));

    const result = await run('flow-definition/BM-Test-IaC-Flow.json');

    expect(result).toMatchObject({ test_cases_deleted: PAGE_SIZE * 3 + 1 });
    expect(testCases).toEqual([]);
  });

  it('treats an already-deleted test case as done rather than failing', async () => {
    // The generated config being deleted removes the DynamoDB items too, and
    // their stream deletes the same test cases by name. Whichever gets there
    // second finds nothing, which is the outcome both wanted.
    keys.add('test-case-data/BM-Test-IaC-Flow.json');
    testCases = [
      { Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' },
      { Id: 'tc-2', Name: 'BM-Test-IaC-Flow:2' },
    ];
    alreadyGone.add('tc-1');

    const result = await run('flow-definition/BM-Test-IaC-Flow.json');

    expect(deleted.testCaseIds).toEqual(['tc-2']);
    expect(result).toMatchObject({ configs_removed: 1, test_cases_deleted: 1 });
  });

  it('leaves a key that does not name a flow alone, rather than guessing one', async () => {
    // The old <FlowName>/<file>.json layout, which generated nothing under this
    // one and so has nothing to undo. Deriving "flow" from it would go after the
    // config and test cases of a flow called "flow" and leave the real flow's.
    keys.add('test-case-data/BM-Test-IaC-Flow.json');
    testCases = [{ Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' }];

    const result = await run('flow-definition/BM-Test-IaC-Flow/flow.json');

    expect(deleted).toEqual({ keys: [], testCaseIds: [] });
    expect(result).toMatchObject({ configs_removed: 0, test_cases_deleted: 0 });
  });

  it('does not read a folder placeholder as the flow it is named after', async () => {
    // A console "folder" is a zero-byte object whose key ends in "/", so
    // "flow-definition/BM-Test-IaC-Flow/" leaves exactly one segment holding the
    // flow's name. Deleting that leftover from the old layout must not tear down
    // the live BM-Test-IaC-Flow.
    keys.add('flow-definition/BM-Test-IaC-Flow.json');
    keys.add('test-case-data/BM-Test-IaC-Flow.json');
    testCases = [{ Id: 'tc-1', Name: 'BM-Test-IaC-Flow:1.1' }];

    const result = await run('flow-definition/BM-Test-IaC-Flow/');

    expect(deleted).toEqual({ keys: [], testCaseIds: [] });
    expect(result).toMatchObject({ configs_removed: 0, test_cases_deleted: 0 });
  });

  it('fails an upload that names no flow, instead of silently generating nothing', async () => {
    // The other way round from a delete: nothing was going to be generated, and
    // whoever uploaded it wants to hear that rather than wonder where their test
    // cases went.
    const upload = {
      Records: [
        {
          eventName: 'ObjectCreated:Put',
          s3: { bucket: { name: BUCKET }, object: { key: 'flow-definition/BM/flow.json' } },
        },
      ],
    } as unknown as S3Event;

    await expect(handler(upload, { functionName: 'test' })).rejects.toThrow(
      /not a flow definition/
    );
  });
});
