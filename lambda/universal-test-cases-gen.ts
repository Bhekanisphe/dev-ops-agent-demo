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
    GetTestCaseExecutionSummaryCommand,
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
  const FLOW_END_KEYWORD = "flow_ended";

  const MAX_CONCURRENT_EXECUTIONS = 5;

  const TERMINAL_STATUSES = new Set(["PASSED", "FAILED", "STOPPED"]);

  const EXECUTION_POLL_INTERVAL_MS = Number(process.env.EXECUTION_POLL_INTERVAL_MS ?? 15000);

  const BATCH_BUDGET_MS = 660000;

  const WIND_DOWN_MS = 15000;

  const DEFAULT_BUDGET_MS = 900000;

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function errorCode(e: unknown): string | undefined {
    return (e as { name?: string })?.name;
  }

  interface StartedExecution {
    test_case_id: string;
    execution_id: string;
    name: string;
  }

  const RESERVED_ITEM_KEYS = new Set<string>([
    "flow-name",
    "testing-option",
    "queue",
    "hours_of_operation",
    "hours_of_operation_results",
    "caller_number",
    "description",
    // Nothing reads it any more - an execution invokes the real function. It stays
    // listed so an item written before that change is still read as metadata rather
    // than mistaken for a block.
    "lambda_mocks",
  ]);
  
  const connect = new ConnectClient({ region: REGION });
  const dynamodb = new DynamoDBClient({ region: REGION });
  
  interface BlockDef {
    identifier: string;
    message: string;
    action?: { user_action: string; type: string };
    next?: string;
    flowAction?: string;
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
  
      // A prompt laid out over several lines is one line of text to a test case: Connect
      // matches the sentence, so a config that carries the line breaks - a hand-written
      // one, or one generated before this - goes up without them.
      const observeMessage = blockMap.Observe?.M?.message?.S?.replace(/\s+/g, " ").trim();
      if (!observeMessage) {
        if (identifier === QUEUE_TARGET_KEYWORD) {
          blocks[identifier] = { identifier, message: "", next: blockMap.next?.S?.trim() };
          continue;
        }
        const flowAction = blockMap.flow_action?.S?.trim();
        if (flowAction) {
          blocks[identifier] = {
            identifier,
            message: "",
            flowAction,
            next: blockMap.next?.S?.trim(),
          };
          continue;
        }
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
  
  type ChainNode =
    | { kind: "message"; block: BlockDef }
    | { kind: "queue"; next?: string };

  function walkChain(blocks: Record<string, BlockDef>): { nodes: ChainNode[]; endsAtQueue: boolean } {
    const start = blocks[ENTRY_BLOCK_NAME] ?? blocks[FLOW_END_KEYWORD];
    if (!start) {
      throw new Error(
        `No block named "${ENTRY_BLOCK_NAME}" or "${FLOW_END_KEYWORD}" found in config`
      );
    }

    const nodes: ChainNode[] = [];
    const visited = new Set<string>();
    let endsAtQueue = false;
    let current: BlockDef | undefined = start;

    const follow = (from: string, next: string | undefined): BlockDef | undefined => {
      if (next === undefined || next === "") return undefined;
      const nextBlock = blocks[next];
      if (!nextBlock) {
        throw new Error(`Block "${from}" points to unknown next block "${next}"`);
      }
      return nextBlock;
    };

    while (current) {
      if (visited.has(current.identifier)) {
        throw new Error(`Cycle detected in block chain at "${current.identifier}"`);
      }
      visited.add(current.identifier);
      nodes.push({ kind: "message", block: current });

      if (current.next === undefined || current.next === "") {
        break;
      }

      if (current.next === QUEUE_TARGET_KEYWORD) {
        if (visited.has(QUEUE_TARGET_KEYWORD)) {
          throw new Error(`Cycle detected in block chain at "${QUEUE_TARGET_KEYWORD}"`);
        }
        visited.add(QUEUE_TARGET_KEYWORD);
        endsAtQueue = true;

        const afterQueue = blocks[QUEUE_TARGET_KEYWORD]?.next;
        nodes.push({ kind: "queue", next: afterQueue });
        current = follow(QUEUE_TARGET_KEYWORD, afterQueue);
        continue;
      }

      current = follow(current.identifier, current.next);
    }

    return { nodes, endsAtQueue };
  }
  
  // Flow ids by name, for the length of one invocation: every record in a batch is
  // usually the same flow, and listing an instance's flows is several calls now
  // that it follows the pages. Cleared per invocation so a warm container cannot
  // hold the id of a flow that has since been deleted and rebuilt.
  const flowIdsByName = new Map<string, string>();

  // ListContactFlows pages, and it pages at a size the caller does not control past
  // MaxResults: a flow on the second page is still on the instance, so stopping at
  // the first page would refuse a test case for a flow that is really there.
  async function flowIdForName(name: string): Promise<string | undefined> {
    const cached = flowIdsByName.get(name);
    if (cached) return cached;

    const wanted = name.trim().toLowerCase();
    let insensitiveMatch: string | undefined;
    let nextToken: string | undefined;
    let pages = 0;

    do {
      const page = await connect.send(
        new ListContactFlowsCommand({
          InstanceId: INSTANCE_ID,
          MaxResults: 100,
          NextToken: nextToken,
        })
      );
      pages++;

      for (const flow of page.ContactFlowSummaryList ?? []) {
        if (!flow.Id || !flow.Name) continue;
        // An exact name wins wherever it is found; a name differing only in case is
        // held back until every page has been read, so it can never take a page's
        // ordering as an answer.
        if (flow.Name === name) {
          flowIdsByName.set(name, flow.Id);
          return flow.Id;
        }
        if (!insensitiveMatch && flow.Name.trim().toLowerCase() === wanted) {
          insensitiveMatch = flow.Id;
        }
      }

      nextToken = page.NextToken;
    } while (nextToken);

    if (insensitiveMatch) {
      console.log(`No flow is named exactly "${name}"; using the one whose name differs only in case.`);
      flowIdsByName.set(name, insensitiveMatch);
      return insensitiveMatch;
    }

    console.log(`Read ${pages} page(s) of contact flows without finding "${name}".`);
    return undefined;
  }

  async function config(pkValue: string, sortKey: string): Promise<TestCaseConfig | undefined> {
    const dynamodbData = await dynamodb.send(
      new GetItemCommand({
        TableName: TABLE_NAME,
        Key: { [KEY_NAME]: { S: pkValue }, [SORT_KEY]: { S: sortKey } },
        ConsistentRead: true,
      })
    );
  
    // The stream is history and this look-up is live, so a record can name an item
    // that has since been deleted - a definition removed, or a re-upload whose
    // options are named differently from the ones it replaced. There is nothing to
    // build a test case from and nothing wrong: the REMOVE record behind this one is
    // what deletes the test case in Connect. Failing here would fail the whole batch
    // instead, and the event source would retry it fifteen times over, holding up
    // every test case behind it on the shard for as long as it took.
    const item = dynamodbData.Item;
    if (!item) {
      console.log(
        `No config item for ${pkValue} / ${sortKey} - it was deleted after this record was written, so there is nothing to run.`
      );
      return undefined;
    }
  
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
    // A key that starts with "+" is the number the test case dials, so there is no
    // flow to look up and no reason to list any.
    let flowId: string;
    if (pkValue.startsWith("+")) {
      flowId = pkValue;
    } else {
      const found = await flowIdForName(pkValue);
      if (!found) {
        throw new Error(`No contact flow found matching name: ${pkValue}`);
      }
      flowId = found;
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

    const isTerminal = block.next === undefined || block.next === "";

    if (isTerminal) {
      const { actionId, action } = generateDisconnectAction();
      actions.push(action);
      clusterActionIds.push(actionId);
      nextX += 224;
      positions[actionId] = generatePosition(nextX, y);
      actionMetadata[actionId] = { position: positions[actionId] };
    }

    const observation = block.flowAction
      ? generateObservation(
          block.identifier,
          "FlowActionStarted",
          "System",
          eventId,
          { ActionType: block.flowAction },
          actions,
          isTerminal ? null : [block.next!]
        )
      : generateObservation(
          block.identifier,
          "MessageReceived",
          "System",
          eventId,
          { MatchingCriteria: { Type: "Similarity" }, Text: block.message },
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
  
  function buildQueueNode(
    queueArn: string,
    queueDisplayName: string,
    next: string | undefined,
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
    actionMetadata[eventId] = {
      position: positions[eventId],
      parameters: {
        Event: {
          Properties: { ActionParameters: { QueueId: { displayName: queueDisplayName } } },
        },
      },
    };

    const isTerminal = next === undefined || next === "";

    if (isTerminal) {
      const { actionId, action } = generateDisconnectAction();
      actions.push(action);
      clusterActionIds.push(actionId);
      nextX += 224;
      positions[actionId] = generatePosition(nextX, y);
      actionMetadata[actionId] = { position: positions[actionId] };
    }

    const observation = generateObservation(
      QUEUE_TARGET_KEYWORD,
      "FlowActionStarted",
      "System",
      eventId,
      { ActionType: "TransferContactToQueue", ActionParameters: { QueueId: queueArn } },
      actions,
      isTerminal ? null : [next!]
    );

    const cluster = generateCluster(
      QUEUE_TARGET_KEYWORD,
      clusterActionIds,
      { x, y },
      isTerminal ? [] : [null]
    );

    return { observation, cluster };
  }

  function buildTestCase(cfg: TestCaseConfig) {
    const arn = (resourceType: string, resourceId: string) =>
      `arn:aws:connect:${REGION}:${ACCOUNT_ID}:instance/${INSTANCE_ID}/${resourceType}/${resourceId}`;

    const { nodes } = walkChain(cfg.blocks);

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

    // Hours of operation is the only behaviour the execution overrides. A Lambda
    // block is left alone, so the execution invokes the real function and what it
    // answers is what the flow branches on - which is the point of the test.
    const overrideActions: any[] = [hooOverrideAction];

    const initCluster = generateCluster(
      "Interaction 1",
      [initEventId, hooOverrideId],
      { x: 79, y: 35 },
      []
    );
    const annotations: any[] = [initCluster];
    let lastCluster = initCluster;
  
    const nodeObservations: any[] = [];
    const xStart = 618.4;
    const y = 79.2;
    const xStep = 400;

    nodes.forEach((node, i) => {
      const x = xStart + i * xStep;
      const built =
        node.kind === "queue"
          ? buildQueueNode(
              arn("queue", cfg.queue_id),
              cfg.queue_display_name,
              node.next,
              x,
              y,
              positions,
              actionMetadata
            )
          : buildBlockNode(node.block, x, y, positions, actionMetadata);

      nodeObservations.push(built.observation);
      lastCluster.clusterProfile.clusterJunction = [built.cluster.id];
      annotations.push(built.cluster);
      lastCluster = built.cluster;
    });

    const observations = [
      generateObservation(
        "Interaction 1",
        "TestInitiated",
        "System",
        initEventId,
        {},
        overrideActions,
        [nodeObservations[0].Identifier]
      ),
      ...nodeObservations,
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
    const ids: string[] = [];
    let nextToken: string | undefined;

    do {
      const page = await connect.send(
        new ListTestCasesCommand({ InstanceId: INSTANCE_ID, NextToken: nextToken })
      );
      for (const testCase of page.TestCaseSummaryList ?? []) {
        if (testCase.Name === flowName && testCase.Id) ids.push(testCase.Id);
      }
      if (stopAfterFirst && ids.length > 0) break;
      nextToken = page.NextToken;
    } while (nextToken);

    for (const id of ids) {
      try {
        await connect.send(new DeleteTestCaseCommand({ InstanceId: INSTANCE_ID, TestCaseId: id }));
      } catch (e) {
        if ((e as { name?: string })?.name !== "ResourceNotFoundException") throw e;
        console.log(`Test case "${flowName}" (${id}) was already deleted`);
        continue;
      }
      if (stopAfterFirst) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return;
      }
    }
  }
  
  function is_busy(e: unknown): boolean {
    const name = errorCode(e);
    return (
      name === "ServiceQuotaExceededException" ||
      name === "ThrottlingException" ||
      name === "TooManyRequestsException"
    );
  }

  function isInvalidTestCase(e: unknown): boolean {
    return errorCode(e) === "InvalidTestCaseException";
  }

  // Connect says which observation it objected to and why in problemDetails, which
  // is the only thing that identifies the block to go and fix.
  function describeInvalidTestCase(e: unknown): string {
    const details = (e as { problemDetails?: { message?: string }[] })?.problemDetails ?? [];
    const reasons = details
      .map((detail) => detail?.message)
      .filter((message): message is string => Boolean(message));
    const message = (e as { message?: string })?.message?.trim();
    return [message, ...reasons].filter(Boolean).join(" ") || "no reason given";
  }

  async function startExecution(testCaseId: string, deadline: number) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await connect.send(
          new StartTestCaseExecutionCommand({ InstanceId: INSTANCE_ID, TestCaseId: testCaseId })
        );
      } catch (e) {
        if (!is_busy(e) || Date.now() >= deadline) throw e;
        console.log(
          `Connect has no room to start test case ${testCaseId} yet (${errorCode(e)}) — waiting for an execution to finish (attempt ${attempt}).`
        );
        await sleep(EXECUTION_POLL_INTERVAL_MS);
      }
    }
  }

  async function waitForBatch(batch: StartedExecution[], deadline: number): Promise<void> {
    const pending = new Map(batch.map((started) => [started.execution_id, started]));
    if (pending.size === 0) return;

    console.log(
      `Waiting for ${pending.size} execution(s) to finish before starting any more: ${batch
        .map((started) => started.name)
        .join(", ")}`
    );

    while (pending.size > 0) {
      if (Date.now() >= deadline) {
        console.log(
          `Out of time waiting for ${[...pending.values()]
            .map((started) => started.name)
            .join(", ")} — they are on the results table and still being watched, but the next batch may start while they run.`
        );
        return;
      }

      await sleep(EXECUTION_POLL_INTERVAL_MS);

      for (const [execution_id, started] of [...pending]) {
        try {
          const summary = await connect.send(
            new GetTestCaseExecutionSummaryCommand({
              InstanceId: INSTANCE_ID,
              TestCaseId: started.test_case_id,
              TestCaseExecutionId: execution_id,
            })
          );
          if (summary.Status && TERMINAL_STATUSES.has(summary.Status)) {
            console.log(`${started.name} finished as ${summary.Status}.`);
            pending.delete(execution_id);
          }
        } catch (e) {
          if (errorCode(e) === "ResourceNotFoundException") {
            console.log(`${started.name} is gone — nothing left to wait for.`);
            pending.delete(execution_id);
            continue;
          }
          if (is_busy(e)) continue;
          throw e;
        }
      }
    }
  }

  async function run(
    pkValue: string,
    sortKey: string,
    deadline: number
  ): Promise<StartedExecution | undefined> {
    const cfg = await config(pkValue, sortKey);
    if (!cfg) return undefined;

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
  
    // One item Connect will not accept used to throw, which fails the whole stream
    // batch - so the records beside it are delivered again and their test cases run
    // a second time, and the batch never clears. Connect's own reason is the useful
    // thing to say, and then this item is left behind rather than taking the others
    // with it.
    let testCase;
    try {
      testCase = await connect.send(
        new CreateTestCaseCommand({
          InstanceId: INSTANCE_ID,
          Name: cfg.flow_name,
          Description: cfg.description,
          Content: JSON.stringify(buildTestCase(cfg)),
          EntryPoint: entryPoint,
          Tags: { Name: cfg.flow_name, Environment: "Development" },
        })
      );
    } catch (e) {
      if (!isInvalidTestCase(e)) throw e;
      console.error(
        `Connect rejected the content of ${cfg.flow_name} - skipping it, and the rest of the batch runs: ${describeInvalidTestCase(e)}`
      );
      return undefined;
    }
  
    const execution = await startExecution(testCase.TestCaseId!, deadline);

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
  
    console.log(
      `Started ${testName} (execution ${execution.TestCaseExecutionId}) as ${execution.Status}.`
    );

    return {
      test_case_id: execution.TestCaseId!,
      execution_id: execution.TestCaseExecutionId!,
      name: testName,
    };
  }

  export const handler = async (event: DynamoDBStreamEvent, context: Context) => {
    const records = event.Records ?? [];

    flowIdsByName.clear();

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
  
    const remaining = context?.getRemainingTimeInMillis?.() ?? DEFAULT_BUDGET_MS;
    const deadline = Date.now() + Math.max(remaining - WIND_DOWN_MS, 0);

    let batch: StartedExecution[] = [];
    let batches_finished = 0;

    for (let i = 0; i < latestRecords.length; i++) {
      const record = latestRecords[i];
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

      if (batch.length >= MAX_CONCURRENT_EXECUTIONS) {
        await waitForBatch(batch, deadline);
        batch = [];
        batches_finished++;
      }

      if (batches_finished > 0 && Date.now() + BATCH_BUDGET_MS > deadline) {
        console.log(
          `Out of time for another batch of ${MAX_CONCURRENT_EXECUTIONS} — handing back ${
            latestRecords.length - i
          } record(s) to be picked up again.`
        );
        return {
          batchItemFailures: latestRecords
            .slice(i)
            .map((r) => ({ itemIdentifier: r.dynamodb!.SequenceNumber! })),
        };
      }

      const started = await run(pkValue, sortKey, deadline);
      if (started) batch.push(started);
    }

    await waitForBatch(batch, deadline);

    console.log(`${context?.functionName ?? "This function"} started every test case in the batch.`);
    return { batchItemFailures: [] };
  };