import {
    ConnectClient,
    GetTestCaseExecutionSummaryCommand,
    ListTestCaseExecutionRecordsCommand,
    DescribeHoursOfOperationCommand,
    DescribeQueueCommand,
    DescribeContactFlowCommand,
  } from "@aws-sdk/client-connect";
  import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
  import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
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
  const RESULTS_TABLE_NAME = process.env.RESULTS_TABLE_NAME as string;
  
  let test_case_name: string | undefined;
  
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
    messages: ChatMessage[];
  }
  
  interface ResourceNames {
    hoo_name: string;
    queue: string;
    flow: string;
  }
  
  async function get_execution_summary(
    execution_id: string,
    test_case_id: string
  ): Promise<any | null> {
    const get_status = () =>
      connect.send(
        new GetTestCaseExecutionSummaryCommand({
          TestCaseExecutionId: execution_id,
          InstanceId: INSTANCE_ID,
          TestCaseId: test_case_id,
        })
      );
  
    const poll_interval = 3000; // ms
    const max_wait = 480000; // ms
    let waited = 0;
  
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
      if (waited >= max_wait) {
        return null;
      }
      try {
        await sleep(poll_interval);
        waited += poll_interval;
        status = await get_status();
      } catch (e) {
        if (errorCode(e) === "TooManyRequestsException") {
          const backoff = poll_interval + (1 + Math.random() * 2) * 1000;
          await sleep(backoff);
          waited += backoff;
        } else if (errorCode(e) === "ResourceNotFoundException") {
          return null;
        } else {
          throw e;
        }
      }
    }
  
    try {
      return await connect.send(
        new ListTestCaseExecutionRecordsCommand({
          InstanceId: INSTANCE_ID,
          TestCaseId: test_case_id,
          TestCaseExecutionId: execution_id,
        })
      );
    } catch (e) {
      if (errorCode(e) === "ResourceNotFoundException") {
        return null;
      }
      throw e;
    }
  }
  
  function get_test_case_results(results: any): TestCaseResults {
    const test_case_results: TestCaseResults = { messages: [] };
    const messages: ChatMessage[] = [];
  
    for (const r of results.ExecutionRecords) {
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
          test_case_results.hoo_id =
            curr_result_record.Actions[0].ExpectedParameters.Behavior.Properties
              .ActionParameters.HoursOfOperationId;
          test_case_results.hoo_results =
            curr_result_record.Actions[0].ExpectedParameters.Behavior.Properties.Strategy
              .Response.ExecutionResult.Value;
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
          if (curr_result_record.Actions.length > 0) {
            curr_msg.cust_input =
              curr_result_record.Actions[0].ActualParameters.Instruction.Properties.Value;
          }
          messages.push(curr_msg);
        }
  
        if (
            curr_result_record.Event?.Type?.includes("FlowActionStarted") &&
          curr_result_record.Event.Type === "FlowActionStarted"
        ) {
          if (curr_result_record.Status === "FAILED") {
            test_case_results.queue_transfer = "FAILED";
            test_case_results.queue_id = "N/A";
          } else {
            test_case_results.queue_id =
              curr_result_record.Event.Properties.ActionParameters.QueueId;
            test_case_results.queue_transfer = "PASSED";
          }
        } else {
          test_case_results.queue_id = "N/A";
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
  
  function format_messages_for_cell(messages: ChatMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      let line =
        `${msg.identifier} [${msg.Status}]: ` +
        `received="${msg.message_received ?? ""}" ` +
        `expected="${msg.message_expected ?? ""}"`;
      if (msg.cust_input !== undefined) {
        line += ` | Customer input=${msg.cust_input}`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }
  
  const EXCEL_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  const RESULTS_SHEET_NAME = "Test results";

  /**
   * Columns A-I, in the order write_to_excel fills them. Only used for a workbook this
   * function creates itself — an existing file keeps whatever headings it already has.
   */
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
  ];

  /**
   * True when S3 is telling us the workbook simply isn't there yet. A missing key comes
   * back as NoSuchKey, but the SDK reports the same condition as NotFound on some paths
   * (and a 404 with no name at all), so all three count as "create it".
   */
  function is_missing_object(e: unknown): boolean {
    const name = errorCode(e);
    if (name === "NoSuchKey" || name === "NotFound") {
      return true;
    }
    return (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404;
  }

  /** Adds the results sheet with a frozen, bold heading row, and returns it. */
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

  /**
   * The sheet to append this run's row to. The workbook is created on the first run
   * against a fresh bucket — nothing else puts it there, so a missing object is normal
   * rather than an error, and treating it as one used to fail every result until someone
   * uploaded a template by hand.
   *
   * Exported for the unit test; the handler reaches it through write_to_excel.
   */
  export async function load_results_sheet(): Promise<ExcelJS.Worksheet> {
    let excel_buffer_in: Buffer;
    try {
      const getResp = await s3.send(
        new GetObjectCommand({ Bucket: RESULTS_BUCKET, Key: OBJECT_NAME })
      );
      excel_buffer_in = await streamToBuffer(getResp.Body);
    } catch (e) {
      if (!is_missing_object(e)) {
        throw e;
      }
      console.log(
        `s3://${RESULTS_BUCKET}/${OBJECT_NAME} does not exist yet — creating a new workbook.`
      );
      return create_results_sheet(new ExcelJS.Workbook());
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel_buffer_in as any);
    // An object that exists but holds no sheets would otherwise crash on getCell below.
    return workbook.worksheets[0] ?? create_results_sheet(workbook);
  }

  async function write_to_excel(
    test_case_results: TestCaseResults,
    resource_names: ResourceNames
  ): Promise<void> {
    const worksheet = await load_results_sheet();
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
    worksheet.getCell(`B${next_row}`).value = test_case_name!.split(":")[1];
    worksheet.getCell(`C${next_row}`).value = resource_names.hoo_name;
    worksheet.getCell(`D${next_row}`).value = test_case_results.hoo_results;
  
    const cell = worksheet.getCell(`E${next_row}`);
    cell.value = format_messages_for_cell(test_case_results.messages);
    cell.alignment = { wrapText: true, vertical: "top", horizontal: "left"};
  
    worksheet.getCell(`F${next_row}`).value = test_case_results.comp_results;
    worksheet.getCell(`G${next_row}`).value = test_case_results.comp_message;
    worksheet.getCell(`H${next_row}`).value =
      `[${test_case_results.queue_transfer ?? "N/A"}] - ` +
      `Transferred to ${resource_names.queue}`;
    worksheet.getCell(`I${next_row}`).value = test_case_results.contact_id;
  
    const excel_buffer_out = await workbook.xlsx.writeBuffer();
  
    await s3.send(
      new PutObjectCommand({
        Bucket: RESULTS_BUCKET,
        Key: OBJECT_NAME,
        Body: Buffer.from(excel_buffer_out),
        ContentType: EXCEL_CONTENT_TYPE,
      })
    );
  }
  
  export async function handler(
    event: DynamoDBStreamEvent,
    _context?: Context
  ): Promise<{ statusCode: number; body: string }> {
    console.log(event.Records);
  
    for (const record of event.Records as DynamoDBRecord[]) {
      if (record.eventName !== "INSERT") {
        continue;
      }
  
      const keys = record.dynamodb!.Keys as Record<string, any>;
      const test_case_id = Object.values(keys[KEY_NAME])[0] as string;
      const execution_id = Object.values(keys[SORT_NAME])[0] as string;
  
      const new_image = (record.dynamodb!.NewImage ?? {}) as Record<string, any>;
  
      test_case_name = new_image["Test_case_name"]?.S;
  
      console.log(`Test case ID: ${test_case_id}`);
  
      const results = await get_execution_summary(execution_id, test_case_id);
      if (results === null) {
        continue;
      }
      const test_case_results = get_test_case_results(results);
      const resource_names = await get_resource_names(test_case_results);
      await write_to_excel(test_case_results, resource_names);
  
      await dynamodb.send(
        new DeleteItemCommand({
          TableName: RESULTS_TABLE_NAME,
          Key: {
            [KEY_NAME]: { S: test_case_id },
            [SORT_NAME]: { S: execution_id },
          },
        })
      );
    }
  
    return { statusCode: 200, body: "Record Successfully populated in the excel file" };
  }