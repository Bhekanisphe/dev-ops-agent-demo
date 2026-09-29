import {
    ConnectClient,
    GetTestCaseExecutionSummaryCommand,
    ListTestCaseExecutionRecordsCommand,
    DescribeHoursOfOperationCommand,
    DescribeQueueCommand,
    DescribeContactFlowCommand,
  } from "@aws-sdk/client-connect";
  import {
    S3Client,
    GetObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
  } from "@aws-sdk/client-s3";
  import { DynamoDBClient, DeleteItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
  import ExcelJS from "exceljs";
  import type { DynamoDBStreamEvent, DynamoDBRecord, Context } from "aws-lambda";
  
  const connect = new ConnectClient({});
  const s3 = new S3Client({});
  const dynamodb = new DynamoDBClient({});
  
  const INSTANCE_ID = process.env.INSTANCE_ID as string;
  const KEY_NAME = process.env.KEY_NAME as string;
  const SORT_NAME = process.env.SORT_NAME as string;
  const RESULTS_BUCKET = process.env.RESULTS_BUCKET as string;
  const OBJECT_NAME = process.env.OBJECT_NAME as string;
  const RESULTS_PREFIX = process.env.RESULTS_PREFIX as string;
  const RESULTS_TABLE_NAME = process.env.RESULTS_TABLE_NAME as string;
  
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  function errorCode(e: unknown): string | undefined {
    return (e as { name?: string })?.name;
  }
  
  async function streamToBuffer(body: any): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  
  interface ChatMessage {
    identifier: string;
    Status: string;
    message_received?: string;
    message_expected?: string;
    cust_input?: string;
  }
  
  interface TestCaseResults {
    init_results?: string;
    flow_id?: string;
    flow_number?: string;
    exec_results?: string;
    contact_id?: string;
    caller_number?: string;
    comp_results?: string;
    comp_message?: string;
    hoo_id?: string;
    hoo_results?: string;
    queue_transfer?: string;
    queue_id?: string;
    started_at?: Date;
    messages: ChatMessage[];
  }


  interface FinishedExecution {
    started_at?: Date;
    records: any[];
  }

  interface ResourceNames {
    hoo_name: string;
    queue: string;
    flow: string;
  }
  

  class StillRunningError extends Error {}

  async function get_execution_summary(
    execution_id: string,
    test_case_id: string,

    deadline: number
  ): Promise<FinishedExecution | null> {
    const get_status = () =>
      connect.send(
        new GetTestCaseExecutionSummaryCommand({
          TestCaseExecutionId: execution_id,
          InstanceId: INSTANCE_ID,
          TestCaseId: test_case_id,
        })
      );

    const poll_interval = 3000;

    let status: any;
    try {
      status = await get_status();
    } catch (e) {
      if (errorCode(e) === "ResourceNotFoundException") {
        console.log(
          `Test case ${test_case_id} not found when starting poll — likely deleted by a newer run. Skipping.`
        );
        return null;
      }
      throw e;
    }

    while (status.Status !== "FAILED" && status.Status !== "PASSED" && status.Status !== 'STOPPED') {

      if (Date.now() >= deadline) {
        throw new StillRunningError(
          `Execution ${execution_id} of test case ${test_case_id} is still ${status.Status} and this invocation is out of time — handing the record back to be retried.`
        );
      }
      try {
        await sleep(poll_interval);
        status = await get_status();
      } catch (e) {
        if (errorCode(e) === "TooManyRequestsException") {
          await sleep(poll_interval + (1 + Math.random() * 2) * 1000);
        } else if (errorCode(e) === "ResourceNotFoundException") {
          return null;
        } else {
          throw e;
        }
      }
    }

    try {
      const recorded = await connect.send(
        new ListTestCaseExecutionRecordsCommand({
          InstanceId: INSTANCE_ID,
          TestCaseId: test_case_id,
          TestCaseExecutionId: execution_id,
        })
      );

      return { started_at: status.StartTime, records: recorded.ExecutionRecords ?? [] };
    } catch (e) {
      if (errorCode(e) === "ResourceNotFoundException") {
        return null;
      }
      throw e;
    }
  }
  

  function customer_input(actions: any[] | undefined): string | undefined {
    for (const action of actions ?? []) {
      const value =
        action?.ActualParameters?.Instruction?.Properties?.Value ??
        action?.ExpectedParameters?.Instruction?.Properties?.Value;
      if (value !== undefined) return value;
    }
    return undefined;
  }

  function get_test_case_results(execution: FinishedExecution): TestCaseResults {

    const test_case_results: TestCaseResults = {
      messages: [],
      queue_id: "N/A",
      started_at: execution.started_at,
    };
    const messages: ChatMessage[] = [];

    for (const r of execution.records) {
      const curr_result_record = JSON.parse(r.Record);
      console.log(curr_result_record);
  
      if (!("Actions" in curr_result_record)) {
        if (curr_result_record.Type === "INITIATION") {
          test_case_results.init_results = r.Status;
          if ("FlowId" in curr_result_record.EntryPoint.Parameters) {
            test_case_results.flow_id = curr_result_record.EntryPoint.Parameters.FlowId;
          } else {
            test_case_results.flow_number =
              curr_result_record.EntryPoint.Parameters.DestinationPhoneNumber;
          }
        }
  
        if (curr_result_record.Type === "EXECUTION_START") {
          test_case_results.exec_results = r.Status;
          test_case_results.contact_id = curr_result_record.ContactId;
          test_case_results.caller_number =
            curr_result_record.EntryPoint.Parameters.SourcePhoneNumber;
        }
  
        if (curr_result_record.Type === "COMPLETION") {
          test_case_results.comp_results = curr_result_record.CompletionReason.Type;
          test_case_results.comp_message = curr_result_record.CompletionReason.Message;
        }
      } else {
        if (curr_result_record.Event.Type === "TestInitiated") {
          const behavior =
            curr_result_record.Actions?.[0]?.ExpectedParameters?.Behavior?.Properties;
          test_case_results.hoo_id = behavior?.ActionParameters?.HoursOfOperationId;
          test_case_results.hoo_results =
            behavior?.Strategy?.Response?.ExecutionResult?.Value;
        }
  
        if (curr_result_record.Event.Type === "MessageReceived") {
          let curr_msg: ChatMessage;
          if (curr_result_record.Status === "FAILED") {
            curr_msg = {
              identifier: curr_result_record.Identifier,
              Status: curr_result_record.Status,
              message_expected: curr_result_record.Event.Properties.Text,
            };
          } else {
            curr_msg = {
              identifier: curr_result_record.Identifier,
              Status: curr_result_record.Status,
              message_received: curr_result_record.Event.Properties.Text,
              message_expected: curr_result_record.Event.Properties.ExpectedText,
            };
          }
          const input = customer_input(curr_result_record.Actions);
          if (input !== undefined) {
            curr_msg.cust_input = input;
          }
          messages.push(curr_msg);
        }

        if (curr_result_record.Event.Type === "FlowActionStarted") {
          if (curr_result_record.Status === "FAILED") {
            test_case_results.queue_transfer = "FAILED";
          } else {
            test_case_results.queue_id =
              curr_result_record.Event.Properties?.ActionParameters?.QueueId ?? "N/A";
            test_case_results.queue_transfer = "PASSED";
          }
        }
      }
    }
  
    test_case_results.messages = messages;
    console.log(test_case_results);
    return test_case_results;
  }
  
  async function get_resource_names(
    test_case_results: TestCaseResults
  ): Promise<ResourceNames> {
    const hooResp = await connect.send(
      new DescribeHoursOfOperationCommand({
        InstanceId: INSTANCE_ID,
        HoursOfOperationId: test_case_results.hoo_id,
      })
    );
    const hoo_name = hooResp.HoursOfOperation!.Name!;
  
    let queue_name: string;
    if (test_case_results.queue_id !== "N/A") {
      const queueResp = await connect.send(
        new DescribeQueueCommand({
          InstanceId: INSTANCE_ID,
          QueueId: test_case_results.queue_id,
        })
      );
      queue_name = queueResp.Queue!.Name!;
    } else {
      queue_name = "N/A";
    }
  
    let flow_name: string;
    if (test_case_results.flow_id !== undefined) {
      const flowResp = await connect.send(
        new DescribeContactFlowCommand({
          InstanceId: INSTANCE_ID,
          ContactFlowId: test_case_results.flow_id,
        })
      );
      flow_name = flowResp.ContactFlow!.Name!;
    } else {
      flow_name = test_case_results.flow_number!;
    }
  
    return { hoo_name, queue: queue_name, flow: flow_name };
  }
  

  function format_messages_for_cell(messages: ChatMessage[]): ExcelJS.CellRichTextValue {
    const bold: Partial<ExcelJS.Font> = { bold: true };
    const rich_text: ExcelJS.RichText[] = [];

    messages.forEach((msg, index) => {
      if (index > 0) {
        rich_text.push({ text: "\n" });
      }

      rich_text.push({ font: bold, text: msg.identifier ?? "step" });
      rich_text.push({ text: ` [${msg.Status}]` });

      const detail: Array<[string, string]> = [];
      if (msg.message_received !== undefined) detail.push(["Received", msg.message_received]);
      if (msg.message_expected !== undefined) detail.push(["Expected", msg.message_expected]);
      if (msg.cust_input !== undefined) detail.push(["Customer input", msg.cust_input]);

      for (const [label, value] of detail) {
        rich_text.push({ font: bold, text: `\n    ${label}: ` });
        rich_text.push({ text: value });
      }
    });

    return { richText: rich_text };
  }

  const RESULTS_TIME_ZONE = "Africa/Johannesburg";
  const RESULTS_TIME_ZONE_LABEL = "SAST";

  const executed_at_parts = new Intl.DateTimeFormat("en-ZA", {
    timeZone: RESULTS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });


  function format_executed_at(at: Date | string | undefined): string {
    if (at === undefined) return "N/A";

    const when = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(when.getTime())) return "N/A";

    const parts: Record<string, string> = {};
    for (const part of executed_at_parts.formatToParts(when)) {
      parts[part.type] = part.value;
    }

    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  
  const EXCEL_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const RESULTS_SHEET_NAME = "Test results";

  const RESULTS_HEADINGS: Array<{ header: string; width: number }> = [
    { header: "Flow/Number", width: 30 },
    { header: "Testing option", width: 30 },
    { header: "Hours of operation", width: 24 },
    { header: "HOO result", width: 14 },
    { header: "Test steps", width: 70 },
    { header: "Test Results", width: 14 },
    { header: "Comments", width: 40 },
    { header: "Queue transfer", width: 34 },
    { header: "Contact ID", width: 38 },
    { header: `Executed at (${RESULTS_TIME_ZONE_LABEL})`, width: 22 },
  ];

  export function flow_results_key(flow: string): string {
    const file_name =
      flow.replace(/[^A-Za-z0-9._+@-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown-flow";

    return `${RESULTS_PREFIX}${file_name}.xlsx`;
  }


  async function workbook_exists(key: string): Promise<boolean> {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: RESULTS_BUCKET, Prefix: key, MaxKeys: 1 })
    );

    return page.Contents?.[0]?.Key === key;
  }


  function is_missing_object(e: unknown): boolean {
    const name = errorCode(e);
    if (name === "NoSuchKey" || name === "NotFound") {
      return true;
    }
    return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
  }


  function create_results_sheet(workbook: ExcelJS.Workbook): ExcelJS.Worksheet {
    const worksheet = workbook.addWorksheet(RESULTS_SHEET_NAME, {
      views: [{ state: "frozen", ySplit: 1 }],
    });

    worksheet.columns = RESULTS_HEADINGS.map((column) => ({ width: column.width }));

    const heading_row = worksheet.addRow(RESULTS_HEADINGS.map((column) => column.header));
    heading_row.font = { bold: true };
    heading_row.alignment = { vertical: "middle" };
    heading_row.commit();

    return worksheet;
  }

  export interface LoadedSheet {
    worksheet: ExcelJS.Worksheet;
    etag?: string;
  }

  export async function load_results_sheet(key: string): Promise<LoadedSheet> {
    const new_workbook = (): LoadedSheet => ({
      worksheet: create_results_sheet(new ExcelJS.Workbook()),
    });

    let excel_buffer_in: Buffer;
    let etag: string | undefined;
    try {
      if (!(await workbook_exists(key))) {
        console.log(`s3://${RESULTS_BUCKET}/${key} does not exist yet — creating a new workbook.`);
        return new_workbook();
      }

      const getResp = await s3.send(new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: key }));
      etag = getResp.ETag;
      excel_buffer_in = await streamToBuffer(getResp.Body);
    } catch (e) {
      if (!is_missing_object(e)) {
        throw e;
      }
      console.log(`s3://${RESULTS_BUCKET}/${key} went away while being read — creating a new workbook.`);
      return new_workbook();
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel_buffer_in as any);

    return { worksheet: workbook.worksheets[0] ?? create_results_sheet(workbook), etag };
  }


  function is_write_conflict(e: unknown): boolean {
    const name = errorCode(e);
    if (name === "PreconditionFailed" || name === "ConditionalRequestConflict") {
      return true;
    }
    const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata
      ?.httpStatusCode;
    return status === 409 || status === 412;
  }

  const MAX_WRITE_ATTEMPTS = 10;

  async function append_result_row(
    key: string,
    test_case_name: string,
    test_case_results: TestCaseResults,
    resource_names: ResourceNames
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await write_result_row(key, test_case_name, test_case_results, resource_names);
        return;
      } catch (e) {
        if (!is_write_conflict(e) || attempt >= MAX_WRITE_ATTEMPTS) throw e;
        console.log(
          `s3://${RESULTS_BUCKET}/${key} was written by another result — re-reading it (attempt ${attempt}).`
        );

        await sleep(100 * attempt + Math.random() * 400);
      }
    }
  }


  async function write_result_row(
    key: string,

    test_case_name: string,
    test_case_results: TestCaseResults,
    resource_names: ResourceNames
  ): Promise<void> {
    const { worksheet, etag } = await load_results_sheet(key);
    const workbook = worksheet.workbook;

    const next_row = worksheet.actualRowCount + 1;

    const red_fill: ExcelJS.Fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFFF0000" },
    };
    const green_fill: ExcelJS.Fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF00FF00" },
    };
  
    if (test_case_results.comp_results === "TIMEOUT") {
      worksheet.getCell(`F${next_row}`).fill = red_fill;
    } else if (test_case_results.comp_results === "SUCCESS") {
      worksheet.getCell(`F${next_row}`).fill = green_fill;
    }
  
    worksheet.getCell(`A${next_row}`).value = resource_names.flow;
    worksheet.getCell(`B${next_row}`).value = test_case_name.split(":")[1];
    worksheet.getCell(`C${next_row}`).value = resource_names.hoo_name;
    worksheet.getCell(`D${next_row}`).value = test_case_results.hoo_results;
  
    worksheet.getCell(`E${next_row}`).value = format_messages_for_cell(
      test_case_results.messages
    );

    worksheet.getCell(`F${next_row}`).value = test_case_results.comp_results;
    worksheet.getCell(`G${next_row}`).value = test_case_results.comp_message;

    worksheet.getCell(`H${next_row}`).value =
      test_case_results.queue_transfer === undefined
        ? "N/A"
        : `[${test_case_results.queue_transfer}] - Transferred to ${resource_names.queue}`;
    worksheet.getCell(`I${next_row}`).value = test_case_results.contact_id;
    worksheet.getCell(`J${next_row}`).value = format_executed_at(test_case_results.started_at);

    worksheet.getRow(next_row).alignment = {
      vertical: "top",
      horizontal: "left",
      wrapText: true,
    };
  
    const excel_buffer_out = await workbook.xlsx.writeBuffer();

    await s3.send(
      new PutObjectCommand({
        Bucket: RESULTS_BUCKET,
        Key: key,
        Body: Buffer.from(excel_buffer_out),
        ContentType: EXCEL_CONTENT_TYPE,

        ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
      })
    );

    console.log(`Wrote the ${resource_names.flow} result to s3://${RESULTS_BUCKET}/${key}`);
  }


  async function write_to_excel(
    test_case_name: string,
    test_case_results: TestCaseResults,
    resource_names: ResourceNames
  ): Promise<void> {
    for (const key of [OBJECT_NAME, flow_results_key(resource_names.flow)]) {
      await append_result_row(key, test_case_name, test_case_results, resource_names);
    }
  }

  const WRITE_BUDGET_MS = 45000;

  const DEFAULT_POLL_BUDGET_MS = 480000;

  async function is_unwritten(test_case_id: string, execution_id: string): Promise<boolean> {
    const { Item } = await dynamodb.send(
      new GetItemCommand({
        TableName: RESULTS_TABLE_NAME,
        Key: {
          [KEY_NAME]: { S: test_case_id },
          [SORT_NAME]: { S: execution_id },
        },
        ConsistentRead: true,
      })
    );
    return Item !== undefined;
  }

  export async function handler(
    event: DynamoDBStreamEvent,
    context?: Context
  ): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
    console.log(event.Records);

    const remaining = context?.getRemainingTimeInMillis?.() ?? DEFAULT_POLL_BUDGET_MS + WRITE_BUDGET_MS;
    const deadline = Date.now() + Math.max(remaining - WRITE_BUDGET_MS, 0);

    const records = event.Records as DynamoDBRecord[];

    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record.eventName !== "INSERT") {
        continue;
      }

      const keys = record.dynamodb!.Keys as Record<string, any>;
      const test_case_id = Object.values(keys[KEY_NAME])[0] as string;
      const execution_id = Object.values(keys[SORT_NAME])[0] as string;

      const new_image = (record.dynamodb!.NewImage ?? {}) as Record<string, any>;

      const test_case_name = (new_image["Test_case_name"]?.S ?? "") as string;

      console.log(`Test case ID: ${test_case_id}`);

      try {
        if (!(await is_unwritten(test_case_id, execution_id))) {
          console.log(
            `Execution ${execution_id} of test case ${test_case_id} has already been written to the workbook. Skipping.`
          );
          continue;
        }

        const execution = await get_execution_summary(execution_id, test_case_id, deadline);
        if (execution === null) {
          continue;
        }
        const test_case_results = get_test_case_results(execution);
        const resource_names = await get_resource_names(test_case_results);
        await write_to_excel(test_case_name, test_case_results, resource_names);

        await dynamodb.send(
          new DeleteItemCommand({
            TableName: RESULTS_TABLE_NAME,
            Key: {
              [KEY_NAME]: { S: test_case_id },
              [SORT_NAME]: { S: execution_id },
            },
          })
        );
      } catch (e) {
        console.error(
          e instanceof StillRunningError
            ? (e as Error).message
            : `Failed to write the result of execution ${execution_id}: ${e}`
        );
        return {
          batchItemFailures: records
            .slice(i)
            .map((r) => ({ itemIdentifier: r.dynamodb!.SequenceNumber! })),
        };
      }
    }

    return { batchItemFailures: [] };
  }