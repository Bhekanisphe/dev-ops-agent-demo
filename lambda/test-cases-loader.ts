import {
    DynamoDBClient,
    BatchWriteItemCommand,
    QueryCommand,
    AttributeValue,
    WriteRequest,
  } from "@aws-sdk/client-dynamodb";
  import { S3Client, GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
  import { marshall } from "@aws-sdk/util-dynamodb";
  import type { S3Event, S3EventRecord, Context } from "aws-lambda";

  const s3 = new S3Client({});
  const dynamodb = new DynamoDBClient({});

  const TABLE_NAME = process.env.AUTO_TEST_TABLE_NAME as string;
  const KEY_NAME = process.env.AUTO_TEST_KEY_NAME as string;
  const SORT_KEY = process.env.AUTO_TEST_SORT_KEY as string;
  const SOURCE_INDEX_NAME = process.env.AUTO_TEST_SOURCE_INDEX as string;

  // Stamped onto every loaded item so a later S3 delete can find what it created.
  const SOURCE_KEY_ATTR = "source_object_key";
  // Stamped onto items that came from a named wrapper ({"test1": {...}, "test2": {...}}),
  // so the DynamoDB item can be traced back to the block that produced it.
  const TEST_CASE_NAME_ATTR = "test_case_name";

  const BATCH_SIZE = 25;
  const MAX_BATCH_RETRIES = 5;

  type TestCaseItem = Record<string, unknown>;
  type ItemKey = Record<string, AttributeValue>;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function streamToString(body: any): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf-8");
  }

  // S3 event keys arrive URL-encoded, with spaces as "+".
  function objectKey(record: S3EventRecord): string {
    return decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
  }

  // The uploaded file may hold a single config object, an array of them, or a map of
  // named configs — {"test1": {...}, "test2": {...}} — which yields one item per name.
  function toCandidates(parsed: unknown, source: string): { label: string; name?: string; value: unknown }[] {
    if (Array.isArray(parsed)) {
      return parsed.map((value, i) => ({ label: `${source}[${i}]`, value }));
    }

    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`${source} is not a JSON object`);
    }

    // A single config carries the table keys at the top level; a named map does not.
    const record = parsed as Record<string, unknown>;
    if (KEY_NAME in record) {
      return [{ label: source, value: record }];
    }

    const names = Object.keys(record);
    if (names.length === 0) {
      throw new Error(`${source} contains no test cases`);
    }

    return names.map((name) => ({ label: `${source}#${name}`, name, value: record[name] }));
  }

  function toItems(parsed: unknown, key: string, source: string): TestCaseItem[] {
    const seen = new Map<string, string>();

    return toCandidates(parsed, source).map(({ label, name, value: candidate }) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new Error(`${label} is not a JSON object`);
      }

      const item = candidate as TestCaseItem;
      // Both keys land in DynamoDB as strings, so a config that writes
      // "testing-option": 1.2 instead of "1.2" still loads cleanly.
      for (const keyName of [KEY_NAME, SORT_KEY]) {
        const value = item[keyName];
        if (value === undefined || value === null || value === "") {
          throw new Error(`${label} is missing required key "${keyName}"`);
        }
        if (typeof value !== "string" && typeof value !== "number") {
          throw new Error(`${label} key "${keyName}" must be a string`);
        }
        item[keyName] = String(value);
      }

      // BatchWriteItem rejects a batch containing two writes to the same key, so
      // point at the offending pair rather than failing with a generic SDK error.
      const itemKey = `${item[KEY_NAME]}#${item[SORT_KEY]}`;
      const duplicate = seen.get(itemKey);
      if (duplicate) {
        throw new Error(
          `${label} and ${duplicate} share the same ${KEY_NAME}/${SORT_KEY} ("${item[KEY_NAME]}" / "${item[SORT_KEY]}") — each test case needs a unique pair`
        );
      }
      seen.set(itemKey, label);

      if (name !== undefined) item[TEST_CASE_NAME_ATTR] = name;
      item[SOURCE_KEY_ATTR] = key;
      return item;
    });
  }

  async function sendBatches(requests: WriteRequest[]): Promise<void> {
    for (let start = 0; start < requests.length; start += BATCH_SIZE) {
      let chunk = requests.slice(start, start + BATCH_SIZE);

      for (let attempt = 0; attempt <= MAX_BATCH_RETRIES; attempt++) {
        const response = await dynamodb.send(
          new BatchWriteItemCommand({ RequestItems: { [TABLE_NAME]: chunk } })
        );

        const unprocessed = response.UnprocessedItems?.[TABLE_NAME] ?? [];
        if (unprocessed.length === 0) break;

        if (attempt === MAX_BATCH_RETRIES) {
          throw new Error(
            `${unprocessed.length} item(s) still unprocessed after ${MAX_BATCH_RETRIES} retries`
          );
        }

        chunk = unprocessed;
        await sleep(2 ** attempt * 100);
      }
    }
  }

  async function objectStillExists(bucket: string, key: string): Promise<boolean> {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (e) {
      const name = (e as { name?: string })?.name;
      const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata
        ?.httpStatusCode;
      if (name === "NotFound" || name === "NoSuchKey" || status === 404) return false;
      throw e;
    }
  }

  async function itemKeysForObject(key: string): Promise<ItemKey[]> {
    const keys: ItemKey[] = [];
    let exclusiveStartKey: ItemKey | undefined;

    do {
      const page = await dynamodb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: SOURCE_INDEX_NAME,
          KeyConditionExpression: "#src = :src",
          ExpressionAttributeNames: { "#src": SOURCE_KEY_ATTR },
          ExpressionAttributeValues: { ":src": { S: key } },
          ExclusiveStartKey: exclusiveStartKey,
        })
      );

      for (const item of page.Items ?? []) {
        keys.push({ [KEY_NAME]: item[KEY_NAME], [SORT_KEY]: item[SORT_KEY] });
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey);

    return keys;
  }

  async function loadRecord(record: S3EventRecord): Promise<number> {
    const bucket = record.s3.bucket.name;
    const key = objectKey(record);
    const source = `s3://${bucket}/${key}`;

    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await streamToString(object.Body);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (e) {
      throw new Error(`${source} is not valid JSON: ${(e as Error).message}`);
    }

    const items = toItems(parsed, key, source);
    await sendBatches(
      items.map((item) => ({
        PutRequest: { Item: marshall(item, { removeUndefinedValues: true }) },
      }))
    );

    console.log(`Loaded ${items.length} item(s) from ${source} into ${TABLE_NAME}`);
    return items.length;
  }

  async function removeRecord(record: S3EventRecord): Promise<number> {
    const bucket = record.s3.bucket.name;
    const key = objectKey(record);
    const source = `s3://${bucket}/${key}`;

    // The bucket is versioned, so ObjectRemoved also fires when an old version is
    // purged. If the key still resolves, the config is live and must stay.
    if (await objectStillExists(bucket, key)) {
      console.log(`${source} still exists (noncurrent version removed) — keeping items`);
      return 0;
    }

    const itemKeys = await itemKeysForObject(key);
    if (itemKeys.length === 0) {
      console.log(`No items in ${TABLE_NAME} were loaded from ${source}`);
      return 0;
    }

    await sendBatches(itemKeys.map((Key) => ({ DeleteRequest: { Key } })));

    console.log(`Removed ${itemKeys.length} item(s) loaded from ${source}`);
    return itemKeys.length;
  }

  export const handler = async (event: S3Event, context: Context) => {
    let loaded = 0;
    let removed = 0;

    for (const record of event.Records ?? []) {
      if (record.eventName?.startsWith("ObjectRemoved:")) {
        removed += await removeRecord(record);
      } else {
        loaded += await loadRecord(record);
      }
    }

    return {
      statusCode: 200,
      items_loaded: loaded,
      items_removed: removed,
      function_name: context.functionName,
    };
  };
