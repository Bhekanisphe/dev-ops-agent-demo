// Loading a generated config into DynamoDB, and - the part these tests exist for -
// unloading what the config no longer holds.
//
// The table is what triggers a run: an insert or a modify puts a test case into
// Connect and executes it, and a delete takes it out again. So a config that used to
// hold 65 test cases and now holds three has to leave three behind, not 65 with three
// of them freshened up. Otherwise selecting the paths you care about would grow the
// instance rather than shrink it.

jest.mock('@aws-sdk/client-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/client-dynamodb');
  const send = jest.fn();
  return { ...actual, DynamoDBClient: jest.fn(() => ({ send })), __send: send };
});

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  const send = jest.fn();
  return { ...actual, S3Client: jest.fn(() => ({ send })), __send: send };
});

import {
  BatchWriteItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';

const TABLE_NAME = 'rsa-automated-testing-cdk';
const KEY_NAME = 'flow-name';
const SORT_KEY = 'testing-option';
const SOURCE_INDEX = 'source-object-key-index';
const SOURCE_KEY_ATTR = 'source_object_key';
const BUCKET = 'rsa-automated-test-cases-results';

process.env.AUTO_TEST_TABLE_NAME = TABLE_NAME;
process.env.AUTO_TEST_KEY_NAME = KEY_NAME;
process.env.AUTO_TEST_SORT_KEY = SORT_KEY;
process.env.AUTO_TEST_SOURCE_INDEX = SOURCE_INDEX;

const { handler } = require('../lambda/test-cases-loader') as {
  handler: (event: S3Event, context: any) => Promise<Record<string, unknown>>;
};

const { __send: dynamoSend } = jest.requireMock('@aws-sdk/client-dynamodb') as {
  __send: jest.Mock;
};
const { __send: s3Send } = jest.requireMock('@aws-sdk/client-s3') as { __send: jest.Mock };

// The table, as the fake sees it: one entry per item, keyed the way the real one is.
let table: Map<string, Record<string, AttributeValue>>;
// What is in the bucket, so a delete event can be told from a delete marker over a
// key that is still there.
let objects: Map<string, unknown>;

const entry = (item: Record<string, AttributeValue>) => `${item[KEY_NAME].S}#${item[SORT_KEY].S}`;

const itemsFrom = (key: string) =>
  [...table.values()]
    .filter((item) => item[SOURCE_KEY_ATTR]?.S === key)
    .map((item) => item[SORT_KEY].S as string)
    .sort();

beforeEach(() => {
  table = new Map();
  objects = new Map();
  jest.spyOn(console, 'log').mockImplementation(() => {});

  dynamoSend.mockReset();
  dynamoSend.mockImplementation(async (command: any) => {
    if (command instanceof QueryCommand) {
      expect(command.input.IndexName).toBe(SOURCE_INDEX);
      const source = command.input.ExpressionAttributeValues![':src'].S;
      return {
        Items: [...table.values()]
          .filter((item) => item[SOURCE_KEY_ATTR]?.S === source)
          // Projected the way an index is: the keys, and the attribute it is on.
          .map((item) => ({
            [KEY_NAME]: item[KEY_NAME],
            [SORT_KEY]: item[SORT_KEY],
            [SOURCE_KEY_ATTR]: item[SOURCE_KEY_ATTR],
          })),
      };
    }
    if (command instanceof BatchWriteItemCommand) {
      for (const request of command.input.RequestItems![TABLE_NAME]) {
        if (request.PutRequest) {
          const item = request.PutRequest.Item as Record<string, AttributeValue>;
          table.set(entry(item), item);
        }
        if (request.DeleteRequest) {
          const key = request.DeleteRequest.Key as Record<string, AttributeValue>;
          table.delete(entry(key));
        }
      }
      return { UnprocessedItems: {} };
    }
    throw new Error(`unexpected DynamoDB command ${command.constructor.name}`);
  });

  s3Send.mockReset();
  s3Send.mockImplementation(async (command: any) => {
    const key = command.input.Key as string;
    if (command instanceof HeadObjectCommand) {
      if (!objects.has(key)) {
        const error: any = new Error(`no such key ${key}`);
        error.name = 'NotFound';
        throw error;
      }
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const body = JSON.stringify(objects.get(key));
      return {
        Body: (async function* () {
          yield Buffer.from(body);
        })(),
      };
    }
    throw new Error(`unexpected S3 command ${command.constructor.name}`);
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const event = (key: string, eventName: string): S3Event =>
  ({
    Records: [{ eventName, s3: { bucket: { name: BUCKET }, object: { key } } }],
  } as unknown as S3Event);

// One test case per label, in the shape the generator writes: an object keyed by the
// label, each holding the flow name and the label itself.
const config = (flowName: string, labels: string[]) =>
  Object.fromEntries(
    labels.map((label) => [
      label,
      { [KEY_NAME]: flowName, [SORT_KEY]: label, hours_of_operation: 'hoo-1' },
    ])
  );

const load = async (key: string, flowName: string, labels: string[]) => {
  objects.set(key, config(flowName, labels));
  return handler(event(key, 'ObjectCreated:Put'), { functionName: 'test' });
};

describe('loading a generated config', () => {
  const KEY = 'test-case-data/BM-Test-IaC-Flow.json';

  it('loads one item per test case', async () => {
    const result = await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '1.2', '2']);

    expect(itemsFrom(KEY)).toEqual(['1.1', '1.2', '2']);
    expect(result.items_loaded).toBe(3);
    expect(result.items_removed).toBe(0);
  });

  it('removes the test cases a narrowed config no longer holds', async () => {
    await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '1.2', '2', 'OutOfHour']);

    const result = await load(KEY, 'BM-Test-IaC-Flow', ['1.2']);

    expect(itemsFrom(KEY)).toEqual(['1.2']);
    expect(result.items_loaded).toBe(1);
    expect(result.items_removed).toBe(3);
  });

  it('leaves the items alone when the config has not changed', async () => {
    await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '2']);

    const result = await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '2']);

    expect(itemsFrom(KEY)).toEqual(['1.1', '2']);
    expect(result.items_removed).toBe(0);
  });

  it('does not touch the test cases of another flow', async () => {
    const other = 'test-case-data/Other-Flow.json';
    await load(other, 'Other-Flow', ['1', '2']);
    await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '1.2']);

    await load(KEY, 'BM-Test-IaC-Flow', ['1.1']);

    expect(itemsFrom(KEY)).toEqual(['1.1']);
    expect(itemsFrom(other)).toEqual(['1', '2']);
  });

  it('removes every item when the config itself is deleted', async () => {
    await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '2']);
    objects.delete(KEY);

    const result = await handler(event(KEY, 'ObjectRemoved:Delete'), { functionName: 'test' });

    expect(itemsFrom(KEY)).toEqual([]);
    expect(result.items_removed).toBe(2);
  });

  it('keeps the items when only a noncurrent version was removed', async () => {
    await load(KEY, 'BM-Test-IaC-Flow', ['1.1', '2']);

    const result = await handler(event(KEY, 'ObjectRemoved:DeleteMarkerCreated'), {
      functionName: 'test',
    });

    expect(itemsFrom(KEY)).toEqual(['1.1', '2']);
    expect(result.items_removed).toBe(0);
  });
});
