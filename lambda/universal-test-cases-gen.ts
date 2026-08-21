import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    AttributeValue,
  } from "@aws-sdk/client-dynamodb";
  import {
    ConnectClient,
    DescribeQueueCommand,
    DescribeHoursOfOperationCommand,
    ListContactFlowsCommand,
    ListTestCasesCommand,
    CreateTestCaseCommand,
    DeleteTestCaseCommand,
    StartTestCaseExecutionCommand,
    DescribeTestCaseCommand,
  } from "@aws-sdk/client-connect";
  import { randomUUID } from "crypto";
  import { DynamoDBStreamEvent, DynamoDBRecord, Context } from "aws-lambda";

  const TABLE_NAME = process.env.AUTO_TEST_TABLE_NAME!;
  const KEY_NAME = process.env.AUTO_TEST_KEY_NAME!;
  const SORT_KEY = process.env.AUTO_TEST_SORT_KEY!;
  const INSTANCE_ID = process.env.INSTANCE_ID!;
  const REGION = process.env.REGION!;
  const ACCOUNT_ID = process.env.ACCOUNT_ID!;
  const RESULTS_TABLE = process.env.RESULTS_TABLE_NAME!;
  const RESULTS_TABLE_KEY = process.env.RESULTS_TABLE_KEY!;
  const RESULTS_TABLE_SORT_KEY = process.env.RESULTS_TABLE_SORT_KEY!;
  
  const ENTRY_BLOCK_NAME = "welcome_message";
  const QUEUE_TARGET_KEYWORD = "check_queue";
  
  const RESERVED_ITEM_KEYS = new Set<string>([
    "flow-name",
    "testing-option",
    "queue",
    "hours_of_operation",
    "hours_of_operation_results",
    "caller_number",
    "description",
  ]);
  
  const connect = new ConnectClient({ region: REGION });
  const dynamodb = new DynamoDBClient({ region: REGION });
  
  interface BlockDef {
    identifier: string;
    message: string;
    action?: { user_action: string; type: string };
    next?: string;
  }
  
  interface TestCaseConfig {
    instance_id: string;
    region: string;
    account_id: string;
    flow_name: string;
    description: string;
    flow_id: string;
    hoo_id: string;
    hoo_result: string;
    queue_id: string;
    queue_display_name: string;
    hoo_display_name: string;
    caller_number: string;
    blocks: Record<string, BlockDef>;
  }
  
  type Position = { x: number; y: number };
  
  function parseBlocks(item: Record<string, AttributeValue>): Record<string, BlockDef> {
    const blocks: Record<string, BlockDef> = {};
  
    for (const [rawKey, value] of Object.entries(item)) {
      if (RESERVED_ITEM_KEYS.has(rawKey)) continue;
      if (!value.M) continue;
  
      const identifier = rawKey.trim();
      const blockMap = value.M;
  
      const observeMessage = blockMap.Observe?.M?.message?.S;
      if (!observeMessage) {
        throw new Error(`Block "${identifier}" is missing Observe.message`);
      }
  
      const actionMap = blockMap.Action?.M;
      const action = actionMap
        ? {
            user_action: actionMap.user_action?.S ?? "",
            type: actionMap.type?.S ?? "",
          }
        : undefined;
  
      const next = blockMap.next?.S?.trim();
  
      blocks[identifier] = { identifier, message: observeMessage, action, next };
    }
  
    return blocks;
  }
  
  function walkChain(blocks: Record<string, BlockDef>): { chain: BlockDef[]; endsAtQueue: boolean } {
    const start = blocks[ENTRY_BLOCK_NAME];
    if (!start) {
      throw new Error(`No block named "${ENTRY_BLOCK_NAME}" found in config`);
    }

    const chain: BlockDef[] = [];
    const visited = new Set<string>();
    let endsAtQueue = false;
    let current: BlockDef | undefined = start;

    while (current) {
      if (visited.has(current.identifier)) {
        throw new Error(`Cycle detected in block chain at "${current.identifier}"`);
      }
      visited.add(current.identifier);
      chain.push(current);

      // No "next" on the config item — this block is the last one and the test ends here.
      if (current.next === undefined || current.next === "") {
        break;
      }

      if (current.next === QUEUE_TARGET_KEYWORD) {
        endsAtQueue = true;
        break;
      }

      const nextBlock: BlockDef | undefined = blocks[current.next];
      if (!nextBlock) {
        throw new Error(
          `Block "${current.identifier}" points to unknown next block "${current.next}"`
        );
      }
      current = nextBlock;
    }

    return { chain, endsAtQueue };
  }
  
  async function config(pkValue: string, sortKey: string): Promise<TestCaseConfig> {
    const dynamodbData = await dynamodb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { [KEY_NAME]: { S: pkValue }, [SORT_KEY]: { S: sortKey } },
        ConsistentRead: true,
      })
    );
  
    const item = dynamodbData.Item;
    if (!item) {
      throw new Error(`No config item found for ${pkValue} / ${sortKey}`);
    }
  
    // A flow whose chain ends without "check_queue" needs no queue configured.
    const queue = item.queue?.S
      ? await connect.send(
          new DescribeQueueCommand({ InstanceId: INSTANCE_ID, QueueId: item.queue.S })
        )
      : undefined;
    const hoo = await connect.send(
      new DescribeHoursOfOperationCommand({
        InstanceId: INSTANCE_ID,
        HoursOfOperationId: item.hours_of_operation?.S,
      })
    );
    const flows = await connect.send(
      new ListContactFlowsCommand({ InstanceId: INSTANCE_ID, MaxResults: 200 })
    );
  
    let flowId: string;
    if (pkValue.startsWith("+")) {
      flowId = pkValue;
    } else {
      const match = flows.ContactFlowSummaryList?.find((f) => f.Name === pkValue);
      if (!match?.Id) {
        throw new Error(`No contact flow found matching name: ${pkValue}`);
      }
      flowId = match.Id;
    }
  
    const blocks = parseBlocks(item);
  
    const testCaseData: TestCaseConfig = {
      instance_id: INSTANCE_ID,
      region: REGION,
      account_id: ACCOUNT_ID,
      flow_name: `${item["flow-name"]?.S ?? ""}:${item["testing-option"]?.S ?? ""}`,
      description: item.description?.S ?? "",
      flow_id: flowId,
      hoo_id: item.hours_of_operation?.S ?? "",
      hoo_result: item.hours_of_operation_results?.S ?? "",
      queue_id: item.queue?.S ?? "",
      queue_display_name: queue?.Queue?.Name ?? "",
      hoo_display_name: hoo.HoursOfOperation?.Name ?? "",
      caller_number: item.caller_number?.S ?? "",
      blocks,
    };
  
    console.log(testCaseData);
    return testCaseData;
  }
  
  function generatePosition(x: number, y: number): Position {
    return { x, y };
  }
  
  function generateCheckHooOverride(hooArn: string, hooDisplayName: string, result = "InHour") {
    const actionId = randomUUID();
    return {
      actionId,
      action: {
        Parameters: {
          ActionType: "OverrideSystemBehavior",
          Behavior: {
            Type: "FlowAction",
            Properties: {
              ActionType: "CheckHoursOfOperation",
              ActionParameters: { HoursOfOperationId: hooArn },
              Strategy: {
                Type: "MockResponse",
                Response: { Type: "ExecutionResult", ExecutionResult: { Value: result } },
              },
            },
          },
        },
        Identifier: actionId,
        Type: "OverrideSystemBehavior",
        Transitions: {},
      },
      hooDisplayName,
    };
  }
  
  function generateUserAction(userValue: string, type: string) {
    const actionId = randomUUID();
    return {
      actionId,
      action: {
        Parameters: {
          Actor: "Customer",
          Instruction: { Type: type, Properties: { Value: userValue } },
        },
        Identifier: actionId,
        Type: "SendInstruction",
        Transitions: {},
      },
    };
  }
  
  function generateDisconnectAction() {
    const actionId = randomUUID();
    return {
      actionId,
      action: {
        Parameters: { ActionType: "TestControl", Command: { Type: "EndTest" } },
        Identifier: actionId,
        Type: "TestControl",
        Transitions: {},
      },
    };
  }
  
  function generateObservation(
    identifier: string,
    eventType: string,
    actor: string,
    actionId: string,
    eventProps: Record<string, any>,
    actions: any[],
    nextObservations: string[] | null
  ) {
    return {
      Identifier: identifier,
      Event: { Type: eventType, Actor: actor, Identifier: actionId, Properties: eventProps },
      Actions: actions,
      Transitions:
        nextObservations && nextObservations.length ? { NextObservations: nextObservations } : {},
    };
  }
  
  function generateCluster(
    name: string,
    actionIds: string[],
    position: Position,
    junction: (string | null)[],
    size?: { width: number; height: number }
  ) {
    return {
      type: "cluster",
      id: randomUUID(),
      content: "",
      actionId: "",
      isFolded: false,
      position,
      size: size ?? { width: 575, height: 273 },
      clusterProfile: {
        name,
        actionIds,
        style: "grid",
        clusterJunction: junction,
        locked: true,
      },
    };
  }
  
  function buildBlockNode(
    block: BlockDef,
    x: number,
    y: number,
    positions: Record<string, Position>,
    actionMetadata: Record<string, any>
  ): { observation: any; cluster: any } {
    const eventId = randomUUID();
    const clusterActionIds = [eventId];
    const actions: any[] = [];
    let nextX = x;

    positions[eventId] = generatePosition(x, y);
    actionMetadata[eventId] = { position: positions[eventId] };

    if (block.action) {
      const { actionId, action } = generateUserAction(block.action.user_action, block.action.type);
      actions.push(action);
      clusterActionIds.push(actionId);
      nextX += 224;
      positions[actionId] = generatePosition(nextX, y);
      actionMetadata[actionId] = { position: positions[actionId] };
    }

    // No "next" — end the test on this block instead of transitioning anywhere.
    const isTerminal = block.next === undefined || block.next === "";

    if (isTerminal) {
      const { actionId, action } = generateDisconnectAction();
      actions.push(action);
      clusterActionIds.push(actionId);
      nextX += 224;
      positions[actionId] = generatePosition(nextX, y);
      actionMetadata[actionId] = { position: positions[actionId] };
    }

    const observation = generateObservation(
      block.identifier,
      "MessageReceived",
      "System",
      eventId,
      { MatchingCriteria: { Type: "Inclusion" }, Text: block.message },
      actions,
      isTerminal ? null : [block.next!]
    );

    const cluster = generateCluster(
      block.identifier,
      clusterActionIds,
      { x, y },
      isTerminal ? [] : [null]
    );

    return { observation, cluster };
  }
  
  function buildTestCase(cfg: TestCaseConfig) {
    const arn = (resourceType: string, resourceId: string) =>
      `arn:aws:connect:${REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}/${resourceType}/${resourceId}`;
  
    const { chain, endsAtQueue } = walkChain(cfg.blocks);

    const initEventId = randomUUID();
    const { actionId: hooOverrideId, action: hooOverrideAction } = generateCheckHooOverride(
      arn("operating-hours", cfg.hoo_id),
      cfg.hoo_display_name,
      cfg.hoo_result
    );

    const positions: Record<string, Position> = {
      [initEventId]: generatePosition(91.2, 79.2),
      [hooOverrideId]: generatePosition(315.2, 79.2),
    };
    const actionMetadata: Record<string, any> = {
      [initEventId]: { position: positions[initEventId] },
      [hooOverrideId]: {
        position: positions[hooOverrideId],
        parameters: {
          Behavior: {
            Properties: {
              ActionParameters: { HoursOfOperationId: { displayName: cfg.hoo_display_name } },
            },
          },
        },
      },
    };
  
    const initCluster = generateCluster(
      "Interaction 1",
      [initEventId, hooOverrideId],
      { x: 79, y: 35 },
      []
    );
    const annotations: any[] = [initCluster];
    let lastCluster = initCluster;
  
    const blockObservations: any[] = [];
    const xStart = 618.4;
    const y = 79.2;
    const xStep = 400;
  
    chain.forEach((block, i) => {
      const x = xStart + i * xStep;
      const { observation, cluster } = buildBlockNode(block, x, y, positions, actionMetadata);
      blockObservations.push(observation);
      lastCluster.clusterProfile.clusterJunction = [cluster.id];
      annotations.push(cluster);
      lastCluster = cluster;
    });
  
    // Only append the queue transfer + end-test tail when the chain ends on "check_queue".
    // Otherwise the last block already ends the test itself.
    const tailObservations: any[] = [];
    if (endsAtQueue) {
      const queueEventId = randomUUID();
      const { actionId: disconnectId, action: disconnectAction } = generateDisconnectAction();

      const checkQueuePos = generatePosition(xStart + chain.length * xStep, y);
      positions[queueEventId] = checkQueuePos;
      positions[disconnectId] = generatePosition(checkQueuePos.x + 224, checkQueuePos.y);
      actionMetadata[queueEventId] = {
        position: positions[queueEventId],
        parameters: {
          Event: {
            Properties: { ActionParameters: { QueueId: { displayName: cfg.queue_display_name } } },
          },
        },
      };
      actionMetadata[disconnectId] = { position: positions[disconnectId] };

      tailObservations.push(
        generateObservation(
          QUEUE_TARGET_KEYWORD,
          "FlowActionStarted",
          "System",
          queueEventId,
          {
            ActionType: "TransferContactToQueue",
            ActionParameters: { QueueId: arn("queue", cfg.queue_id) },
          },
          [disconnectAction],
          null
        )
      );

      const checkQueueCluster = generateCluster(
        QUEUE_TARGET_KEYWORD,
        [queueEventId, disconnectId],
        checkQueuePos,
        []
      );
      lastCluster.clusterProfile.clusterJunction = [checkQueueCluster.id];
      annotations.push(checkQueueCluster);
    }

    const observations = [
      generateObservation(
        "Interaction 1",
        "TestInitiated",
        "System",
        initEventId,
        {},
        [hooOverrideAction],
        [ENTRY_BLOCK_NAME]
      ),
      ...blockObservations,
      ...tailObservations,
    ];

    const entryPoint = cfg.flow_id.startsWith("+")
      ? {
          ChatEntryPointParameters: null,
          Type: "VOICE_CALL",
          VoiceCallEntryPointParameters: {
            DestinationPhoneNumber: cfg.flow_id,
            SourcePhoneNumber: cfg.caller_number,
            TranscriptionLanguageCodes: null,
          },
        }
      : {
          ChatEntryPointParameters: null,
          Type: "VOICE_CALL",
          VoiceCallEntryPointParameters: {
            SourcePhoneNumber: cfg.caller_number,
            FlowId: cfg.flow_id,
            TranscriptionLanguageCodes: null,
          },
        };
  
    return {
      Version: "2019-10-30",
      Metadata: {
        entryPointPosition: { x: 40, y: 40 },
        ActionMetadata: actionMetadata,
        Annotations: annotations,
        StartAction: "",
        name: cfg.flow_name,
        description: cfg.description,
        initializationData: '{"Attributes":{}}',
        entryPoint,
      },
      Observations: observations,
    };
  }
  
  async function deleteTestCasesByName(flowName: string, stopAfterFirst = false): Promise<void> {
    let nextToken: string | undefined;
    do {
      const page = await connect.send(
        new ListTestCasesCommand({ InstanceId: INSTANCE_ID, NextToken: nextToken })
      );
      for (const testCase of page.TestCaseSummaryList ?? []) {
        if (testCase.Name === flowName && testCase.Id) {
          await connect.send(new DeleteTestCaseCommand({ InstanceId: INSTANCE_ID, TestCaseId: testCase.Id }));
          if (stopAfterFirst) {
            await new Promise((resolve) => setTimeout(resolve, 10_000));
            return;
          }
        }
      }
      nextToken = page.NextToken;
    } while (nextToken);
  }
  
  async function run(pkValue: string, sortKey: string): Promise<string | undefined> {
    const cfg = await config(pkValue, sortKey);
  
    await deleteTestCasesByName(cfg.flow_name, true);
  
    const entryPoint = cfg.flow_id.startsWith("+")
      ? {
          Type: "VOICE_CALL" as const,
          VoiceCallEntryPointParameters: {
            DestinationPhoneNumber: cfg.flow_id,
            SourcePhoneNumber: cfg.caller_number,
          },
        }
      : {
          Type: "VOICE_CALL" as const,
          VoiceCallEntryPointParameters: {
            SourcePhoneNumber: cfg.caller_number,
            FlowId: cfg.flow_id,
          },
        };
  
    const testCase = await connect.send(
      new CreateTestCaseCommand({
        InstanceId: INSTANCE_ID,
        Name: cfg.flow_name,
        Description: cfg.description,
        Content: JSON.stringify(buildTestCase(cfg)),
        EntryPoint: entryPoint,
        Tags: { Name: cfg.flow_name, Environment: "Development" },
      })
    );
  
    const execution = await connect.send(
      new StartTestCaseExecutionCommand({ InstanceId: INSTANCE_ID, TestCaseId: testCase.TestCaseId })
    );
  
    const described = await connect.send(
      new DescribeTestCaseCommand({ InstanceId: INSTANCE_ID, TestCaseId: testCase.TestCaseId })
    );
    const testName = described.TestCase?.Name ?? cfg.flow_name;
  
    await dynamodb.send(
      new PutItemCommand({
        TableName: RESULTS_TABLE,
        Item: {
          [RESULTS_TABLE_KEY]: { S: execution.TestCaseId! },
          [RESULTS_TABLE_SORT_KEY]: { S: execution.TestCaseExecutionId! },
          Test_case_name: { S: testName },
        },
      })
    );
  
    return execution.Status;
  }
  
  export const handler = async (event: DynamoDBStreamEvent, context: Context) => {
    const records = event.Records ?? [];
  
    const recordKey = (record: DynamoDBRecord): string => {
      const keys = record.dynamodb!.Keys!;
      return `${keys[KEY_NAME].S}#${keys[SORT_KEY].S}`;
    };
  
    const grouped = new Map<string, DynamoDBRecord[]>();
    for (const record of records) {
      const k = recordKey(record);
      if (!grouped.has(k)) grouped.set(k, []);
      grouped.get(k)!.push(record);
    }
  
    const latestRecords: DynamoDBRecord[] = [];
    for (const [k, recs] of grouped) {
      if (recs.length > 1) {
        console.log(
          `Found ${recs.length} records for key ${k} in this batch — keeping the most recent one.`
        );
      }
      const newest = recs.reduce((a, b) =>
        (a.dynamodb!.ApproximateCreationDateTime ?? 0) >= (b.dynamodb!.ApproximateCreationDateTime ?? 0)
          ? a
          : b
      );
      latestRecords.push(newest);
    }
  
    for (const record of latestRecords) {
      const keys = record.dynamodb!.Keys!;
      const pkValue = keys[KEY_NAME].S!;
      const sortKey = keys[SORT_KEY].S!;
      const eventName = record.eventName;
      console.log(`Processing record: pk=${pkValue}, sort=${sortKey}, event=${eventName}`);
  
      if (eventName === "REMOVE") {
        await deleteTestCasesByName(`${pkValue}:${sortKey}`);
        continue;
      }
  
      if (eventName !== "INSERT" && eventName !== "MODIFY") {
        continue;
      }
  
      await run(pkValue, sortKey);
    }
  
    return { statusCode: 200, function_name: context.functionName };
  };