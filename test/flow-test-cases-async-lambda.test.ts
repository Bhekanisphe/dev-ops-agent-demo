// A Lambda invoked asynchronously does not answer where it is called: the contact
// carries on, a "Wait" block holds the call until the invocation returns, and a
// "Load Lambda result" block picks the answer up. The wait is the part that matters
// here - its NextAction is the branch taken when nothing came back, so a walk that
// follows it asserts the flow's apology instead of what it does with the result.

import { generateTestCases } from '../lambda/flow-test-cases-gen';

const DEFAULTS = {
  caller_number: '+1234567890',
  hours_of_operation: '4605e369-8882-44d8-a3e9-069bb7fb7120',
  hours_of_operation_results: 'InHour',
};

const ARN = 'arn:aws:lambda:af-south-1:687244881512:function:rsa-get-cust-ref-cdk';

/** The prompts of one test case, in order. */
const messages = (item: Record<string, any>): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  let name: string | undefined = 'welcome_message';
  while (name && !seen.has(name)) {
    seen.add(name);
    const block: any = item[name];
    expect(block).toBeDefined();
    out.push(block.Observe.message);
    name = block.next;
  }
  return out;
};

/** The one test case whose prompts include this text, so the option naming is not the subject. */
const saying = (items: Record<string, any>, text: string) => {
  const found = Object.entries(items).filter(([, item]) =>
    messages(item as any).some((message) => message.includes(text))
  );
  expect(found.map(([option]) => option)).toHaveLength(1);
  return found[0][1] as Record<string, any>;
};

// The sales sub-flow of BM-Test-IaC-Flow, cut down to the asynchronous lookup: ask
// the Lambda for the authorisation number, wait for it, load it, keep it as an
// attribute, then branch on it.
const lookupFlow = () => ({
  Version: '2019-10-30',
  StartAction: 'welcome',
  Metadata: { name: 'BM-Async-Lookup' },
  Actions: [
    {
      Identifier: 'welcome',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Looking up your reference number.' },
      Transitions: { NextAction: 'invoke' },
    },
    {
      Identifier: 'invoke',
      Type: 'InvokeLambdaFunction',
      Parameters: {
        LambdaFunctionARN: ARN,
        InvocationTimeLimitSeconds: '3',
        InvocationType: 'ASYNCHRONOUS',
        ResponseValidation: { ResponseType: 'JSON' },
      },
      Transitions: {
        NextAction: 'wait',
        Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'wait' }],
      },
    },
    {
      Identifier: 'wait',
      Type: 'Wait',
      Parameters: {
        TimeLimitSeconds: '5',
        InterruptibleEvents: {
          LambdaReturned: {
            AsyncLambdaCompletionEvent: { Identifier: '$.LambdaInvocation.InvocationId' },
          },
        },
      },
      Transitions: {
        // What the console writes: the branch for a wait that ended with nothing.
        NextAction: 'gave_up',
        Conditions: [
          {
            NextAction: 'load',
            Condition: { Operator: 'Equals', Operands: ['LambdaReturned'] },
          },
          {
            NextAction: 'gave_up',
            Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] },
          },
        ],
      },
    },
    {
      Identifier: 'load',
      Type: 'LoadLambdaFunctionResult',
      Parameters: { LambdaInvocationId: '$.LambdaInvocation.InvocationId' },
      Transitions: {
        NextAction: 'keep',
        Errors: [
          { ErrorType: 'NoMatchingError', NextAction: 'gave_up' },
          { ErrorType: 'InProgress', NextAction: 'gave_up' },
        ],
      },
    },
    {
      Identifier: 'keep',
      Type: 'UpdateContactAttributes',
      Parameters: { Attributes: { auth_number: '$.External.auth_number' }, TargetContact: 'Current' },
      Transitions: { NextAction: 'check' },
    },
    {
      Identifier: 'check',
      Type: 'Compare',
      Parameters: { ComparisonValue: '$.External.auth_number' },
      Transitions: {
        NextAction: 'unknown',
        Conditions: [
          { NextAction: 'found', Condition: { Operator: 'Equals', Operands: ['AUTH123456'] } },
          { NextAction: 'priority', Condition: { Operator: 'Equals', Operands: ['24680'] } },
        ],
      },
    },
    {
      Identifier: 'found',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Reference $.Attributes.auth_number found, please hold.' },
      Transitions: { NextAction: 'goodbye' },
    },
    {
      Identifier: 'priority',
      Type: 'MessageParticipant',
      Parameters: { Text: 'You are a priority customer, please hold.' },
      Transitions: { NextAction: 'goodbye' },
    },
    {
      Identifier: 'unknown',
      Type: 'MessageParticipant',
      Parameters: { Text: 'We could not authorise that reference.' },
      Transitions: { NextAction: 'goodbye' },
    },
    {
      Identifier: 'gave_up',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Something went wrong, Goodbye' },
      Transitions: { NextAction: 'goodbye' },
    },
    { Identifier: 'goodbye', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
  ] as any[],
  ActionMetadata: {},
});

const actionIn = (flow: { Actions: any[] }, identifier: string) =>
  flow.Actions.find((action) => action.Identifier === identifier);

// The same lookup, but synchronous: the answer is there when the block returns, so
// the block itself is where a failed invocation shows, down its own Error branch.
const directFlow = () => {
  const flow = lookupFlow();
  const invoke = actionIn(flow, 'invoke');
  invoke.Parameters.InvocationType = 'SYNCHRONOUS';
  invoke.Parameters.InvocationTimeLimitSeconds = '8';
  invoke.Transitions = {
    NextAction: 'keep',
    Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'gave_up' }],
  };
  return flow;
};

// The same synchronous lookup, but a reference it cannot authorise sends the caller
// round again through a Loop block, which is what a real flow does rather than giving
// up on the first try: two more goes, and then whatever it does when it is out of
// goes.
const retryingFlow = () => {
  const flow = directFlow();
  actionIn(flow, 'unknown').Transitions = { NextAction: 'again' };
  flow.Actions.push({
    Identifier: 'again',
    Type: 'Loop',
    Parameters: { LoopCount: '2' },
    Transitions: {
      NextAction: 'gave_up',
      Conditions: [
        { NextAction: 'invoke', Condition: { Operator: 'Equals', Operands: ['ContinueLooping'] } },
        { NextAction: 'gave_up', Condition: { Operator: 'Equals', Operands: ['DoneLooping'] } },
      ],
    },
  });
  return flow;
};

const generate = (flow: unknown) => {
  const warnings: string[] = [];
  const items = generateTestCases(flow, {
    flowName: 'BM-Async-Lookup',
    defaults: DEFAULTS,
    warn: (m) => warnings.push(m),
  });
  return { items, warnings };
};

describe('a Lambda invoked asynchronously and loaded later', () => {
  it('waits for the invocation rather than walking the branch for a wait that ended with nothing', () => {
    const { items } = generate(lookupFlow());

    // Every test case about the answer follows the wait to the load block. The one
    // that does not is the one about the answer never coming, which is named for it.
    const apologising = Object.entries(items)
      .filter(([, item]) => messages(item as any).join(' ').includes('Something went wrong'))
      .map(([option]) => option);

    expect(apologising).toEqual(['rsa-get-cust-ref-cdk-error']);
  });

  it('covers every value the block after the load compares the answer against', () => {
    const { items } = generate(lookupFlow());

    expect(
      Object.entries(items)
        .filter(([option]) => !option.endsWith('-error'))
        .map(([, item]) => messages(item as any)[1])
        .sort()
    ).toEqual([
      'Reference AUTH123456 found, please hold.',
      'We could not authorise that reference.',
      'You are a priority customer, please hold.',
    ]);
  });

  it('has a test case for the answer never coming, down the branch the wait ends on', () => {
    const { items } = generate(lookupFlow());
    const failed = items['rsa-get-cust-ref-cdk-error'];

    expect(messages(failed)).toEqual([
      'Looking up your reference number.',
      'Something went wrong, Goodbye',
    ]);
    // Nothing holds the answer back: the execution invokes the real function, so
    // this test case is the one that passes while that function is down.
    expect(failed.lambda_mocks).toBeUndefined();
  });

  it('has a test case for a synchronous invocation failing, down the block\'s Error branch', () => {
    const { items } = generate(directFlow());
    const failed = items['rsa-get-cust-ref-cdk-error'];

    expect(messages(failed)).toEqual([
      'Looking up your reference number.',
      'Something went wrong, Goodbye',
    ]);
    expect(failed.lambda_mocks).toBeUndefined();
  });

  it('fails a synchronous invocation once, however many times a loop invokes it again', () => {
    const { items } = generate(retryingFlow());

    // Three passes through the invoke block are one invocation of one function on one
    // call, so being down is one test case - not one per pass, under labels a suffix
    // apart that all assert the same apology.
    expect(Object.keys(items).filter((option) => option.endsWith('-error'))).toEqual([
      'rsa-get-cust-ref-cdk-error',
    ]);
  });

  it('runs the retry loop out to the branch the flow takes when the retries are spent', () => {
    const { items } = generate(retryingFlow());
    const rejected = saying(items, 'could not authorise');

    // LoopCount 2: the answer is rejected three times, and then the loop is spent and
    // the flow apologises - which is the branch a path that stopped at the first
    // rejection never reached.
    expect(messages(rejected)).toEqual([
      'Looking up your reference number.',
      'We could not authorise that reference.',
      'We could not authorise that reference.',
      'We could not authorise that reference.',
      'Something went wrong, Goodbye',
    ]);
  });

  it('leaves an invocation alone where failing takes the contact where succeeding does', () => {
    const flow = directFlow();
    actionIn(flow, 'invoke').Transitions.Errors = [
      { ErrorType: 'NoMatchingError', NextAction: 'keep' },
    ];
    const { items } = generate(flow);

    expect(Object.keys(items).filter((option) => option.endsWith('-error'))).toEqual([]);
  });

  it('says so where the flow has a failure branch but names the function at runtime', () => {
    const flow = directFlow();
    actionIn(flow, 'invoke').Parameters.LambdaFunctionARN = '$.Attributes.lookup_arn';
    const { items, warnings } = generate(flow);

    expect(Object.keys(items).filter((option) => option.endsWith('-error'))).toEqual([]);
    expect(warnings.join('\n')).toContain('nothing to name that test case after');
  });

  it('plays back the answer the load block copied into an attribute', () => {
    const { items } = generate(lookupFlow());

    expect(messages(saying(items, 'AUTH123456'))).toEqual([
      'Looking up your reference number.',
      'Reference AUTH123456 found, please hold.',
    ]);
  });

  it('leaves the invocation to the real function, mocking nothing', () => {
    const { items } = generate(lookupFlow());
    const item = saying(items, 'AUTH123456');

    // The declared answer is what the test case asserts, not what it answers with:
    // this one passes when the function really returns AUTH123456 and fails when it
    // returns something the flow sends elsewhere.
    expect(item.lambda_mocks).toBeUndefined();
  });

  it('follows the branch whatever the flow named it, not the console default', () => {
    const flow = lookupFlow();
    const wait = actionIn(flow, 'wait');
    wait.Parameters.InterruptibleEvents = {
      'reference is back': wait.Parameters.InterruptibleEvents.LambdaReturned,
    };
    wait.Transitions.Conditions[0].Condition.Operands = ['reference is back'];
    const { items } = generate(flow);

    expect(messages(saying(items, 'AUTH123456'))).toContain(
      'Reference AUTH123456 found, please hold.'
    );
  });

  it('ends where the flow ends a wait that came back with nothing, when no invocation is in flight', () => {
    const flow = lookupFlow();
    // Synchronous: the answer is already there, so the wait is waiting for nothing.
    actionIn(flow, 'invoke').Parameters.InvocationType = 'SYNCHRONOUS';
    const { items, warnings } = generate(flow);

    expect(Object.values(items).map((item) => messages(item as any))).toEqual([
      ['Looking up your reference number.', 'Something went wrong, Goodbye'],
    ]);
    expect(warnings.join('\n')).toContain('waits for an asynchronous Lambda');
  });

  it('leaves a wait that is not waiting for a Lambda alone', () => {
    const flow = lookupFlow();
    const wait = actionIn(flow, 'wait');
    delete wait.Parameters.InterruptibleEvents;
    wait.Transitions.Conditions = [
      { NextAction: 'gave_up', Condition: { Operator: 'Equals', Operands: ['WaitCompleted'] } },
    ];
    const { items, warnings } = generate(flow);

    expect(Object.values(items).map((item) => messages(item as any))).toEqual([
      ['Looking up your reference number.', 'Something went wrong, Goodbye'],
    ]);
    expect(warnings.join('\n')).not.toContain('waits for an asynchronous Lambda');
  });
});
