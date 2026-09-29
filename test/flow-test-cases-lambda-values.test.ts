// Nothing in a flow export says what a Lambda answers, and a flow can both play
// that answer back and pick its branch on it. What it is expected to answer has to
// be declared beside the definition - and declaring is all it is: the execution
// invokes the real function, so a declared value is what the test case asserts, and
// each branch is covered by a test case that passes only if the answer takes it.

import {
  definitionKey,
  externalVariants,
  flowNameFromKey,
  generateTestCases,
  mergeExternalValues,
  valuesFlowName,
  valuesKey,
  withBranchValues,
} from '../lambda/flow-test-cases-gen';

const DEFAULTS = {
  caller_number: '+1234567890',
  hours_of_operation: 'hoo-123',
  hours_of_operation_results: 'InHour',
};

type Block = { Observe: { message: string }; next?: string };

// Walks the generated config the way universal-test-cases-gen does, so a broken
// chain fails here rather than at test case creation time.
function messages(item: Record<string, any>): string[] {
  const said: string[] = [];
  const seen = new Set<string>();
  let name: string | undefined = 'welcome_message';

  while (name) {
    expect(seen.has(name)).toBe(false);
    seen.add(name);
    expect(item[name]).toBeDefined();
    const block = item[name] as Block;
    said.push(block.Observe.message);
    name = block.next;
  }

  return said;
}

const LAMBDA_ARN = 'arn:aws:lambda:af-south-1:111122223333:function:lookup-customer';

const bankFlow = {
  Version: '2019-10-30',
  StartAction: 'welcome',
  Metadata: { name: 'BM-Test-Lambda-Flow' },
  Actions: [
    {
      Identifier: 'welcome',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Welcome to the bank' },
      Transitions: { NextAction: 'main-menu' },
    },
    {
      Identifier: 'main-menu',
      Type: 'GetParticipantInput',
      Parameters: { Text: 'Press one for your account, press two to hear our address.' },
      Transitions: {
        NextAction: 'hangup',
        Conditions: [
          { NextAction: 'look-up', Condition: { Operator: 'Equals', Operands: ['1'] } },
          { NextAction: 'address', Condition: { Operator: 'Equals', Operands: ['2'] } },
        ],
      },
    },
    {
      Identifier: 'address',
      Type: 'MessageParticipant',
      Parameters: { Text: 'We are at twelve Long Street' },
      Transitions: { NextAction: 'hangup' },
    },
    {
      Identifier: 'look-up',
      Type: 'InvokeLambdaFunction',
      Parameters: { LambdaFunctionARN: LAMBDA_ARN },
      Transitions: { NextAction: 'check-type' },
    },
    {
      Identifier: 'check-type',
      Type: 'Compare',
      Parameters: { ComparisonValue: '$.External.customerType' },
      Transitions: {
        NextAction: 'unknown-type',
        Conditions: [
          { NextAction: 'gold', Condition: { Operator: 'Equals', Operands: ['gold'] } },
          { NextAction: 'standard', Condition: { Operator: 'Equals', Operands: ['standard'] } },
        ],
      },
    },
    {
      Identifier: 'gold',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Thank you for being a gold member' },
      Transitions: { NextAction: 'read-balance' },
    },
    // Nothing but the value, so with no declared answer there is no text to assert
    // and the block is left out of the test case altogether.
    {
      Identifier: 'standard',
      Type: 'MessageParticipant',
      Parameters: { Text: '$.External.balance' },
      Transitions: { NextAction: 'hangup' },
    },
    {
      Identifier: 'read-balance',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Your balance is $.External.balance' },
      Transitions: { NextAction: 'hangup' },
    },
    {
      Identifier: 'unknown-type',
      Type: 'MessageParticipant',
      Parameters: { Text: 'We could not look up your account' },
      Transitions: { NextAction: 'hangup' },
    },
    { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
  ],
};

const generate = (externalValues?: Record<string, string | string[]>) => {
  const warnings: string[] = [];
  const items = generateTestCases(
    { flow: bankFlow, defaults: DEFAULTS },
    {
      flowName: 'BM-Test-Lambda-Flow',
      externalValues,
      warn: (message) => warnings.push(message),
    }
  );
  return { items, warnings };
};

describe('a flow that reads what a Lambda returned', () => {
  describe('with nothing declared', () => {
    const { items, warnings } = generate();

    it('says which file would make the answer assertable', () => {
      expect(warnings.join('\n')).toContain('.values.json');
      expect(warnings.join('\n')).toContain(LAMBDA_ARN);
    });

    it('takes every branch of the check rather than guessing one', () => {
      // Nothing said what the function answers, and it does not need to: the values
      // that decide this block are written on the block, so each of them is a test
      // case and so is the branch none of them takes.
      expect(Object.keys(items).sort()).toEqual([
        '1.customerType-unset',
        '1.gold',
        '1.standard',
        '2',
        'Default',
        'Timeout',
      ]);
      expect(messages(items['1.customerType-unset']).at(-1)).toBe(
        'We could not look up your account'
      );
    });

    it('asserts only the literal text around the value', () => {
      expect(messages(items['1.gold'])).toEqual([
        'Welcome to the bank',
        'Press one for your account, press two to hear our address.',
        'Thank you for being a gold member',
        'Your balance is',
      ]);
    });

    it('mocks nothing, so each branch rests on what the function really answers', () => {
      // The values are read off the block to know which branch to assert, not to
      // answer with: the execution invokes the real function, so of these three test
      // cases the one whose value it answers passes and the other two do not.
      expect(items['1.gold'].lambda_mocks).toBeUndefined();
      expect(items['1.standard'].lambda_mocks).toBeUndefined();
      expect(items['1.customerType-unset'].lambda_mocks).toBeUndefined();
    });
  });

  describe('with one answer declared', () => {
    const { items } = generate({ customerType: 'standard', balance: 'R1 250.00' });

    it('plays the declared answer back wherever a prompt reads it', () => {
      // Declaring is what fills the gap in the words. It is not what decides which
      // branches exist, so the branch it names is covered no differently to the rest.
      expect(messages(items['1.standard'])).toEqual([
        'Welcome to the bank',
        'Press one for your account, press two to hear our address.',
        'R1 250.00',
      ]);
      expect(messages(items['1.gold']).at(-1)).toBe('Your balance is R1 250.00');
    });

    it('asserts the declared answer instead of answering with it', () => {
      // Declaring says what the function is expected to return, and the expectation
      // is the test: the balance is asserted in the words, the invocation is left
      // alone, and a function that answers something else fails the test case.
      expect(items['1.standard'].lambda_mocks).toBeUndefined();
      expect(items['1.gold'].lambda_mocks).toBeUndefined();
      expect(items['1.customerType-unset'].lambda_mocks).toBeUndefined();
    });
  });

  describe('with several answers declared for one key', () => {
    const { items } = generate({ customerType: ['gold', 'standard'], balance: 'R1 250.00' });

    it('covers each answer as its own test case, named for it', () => {
      // Declaring both answers asks for what the block already says, so it adds no
      // test case: the same three branches, one each.
      expect(Object.keys(items).sort()).toEqual([
        '1.customerType-unset',
        '1.gold',
        '1.standard',
        '2',
        'Default',
        'Timeout',
      ]);
    });

    it('asserts what the caller hears on each answer', () => {
      expect(messages(items['1.gold']).slice(2)).toEqual([
        'Thank you for being a gold member',
        'Your balance is R1 250.00',
      ]);
      expect(messages(items['1.standard']).slice(2)).toEqual(['R1 250.00']);
    });

    it('generates a path that never reaches the Lambda once', () => {
      // The address is the same address whatever the lookup answers, so a test
      // case per answer would be the same call run twice.
      expect(messages(items['2']).at(-1)).toBe('We are at twelve Long Street');
      expect(items['2.gold']).toBeUndefined();
    });
  });
});

// A flow does not read the External namespace where it branches on it: it copies
// what the Lambda answered into contact attributes up front and branches on those,
// often several blocks apart. Every path then passes through the copy, so a path
// only depends on the keys it goes on to read - not on all of them.
describe('a flow that copies what the Lambda answered into attributes', () => {
  const LAMBDA = 'arn:aws:lambda:af-south-1:111122223333:function:call-config';

  const flow = {
    Version: '2019-10-30',
    StartAction: 'look-up',
    Metadata: { name: 'Config-Flow' },
    Actions: [
      {
        Identifier: 'look-up',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: LAMBDA },
        Transitions: { NextAction: 'store' },
      },
      // One block, every answer: what makes every path look like it reads them all.
      {
        Identifier: 'store',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: {
            isClosed: '$.External.isClosed',
            isEmergency: '$.External.isEmergency',
            emergencyMessage: '$.External.emergencyMessage',
          },
        },
        Transitions: { NextAction: 'closed?' },
      },
      {
        Identifier: 'closed?',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.Attributes.isClosed' },
        Transitions: {
          NextAction: 'emergency?',
          Conditions: [
            { NextAction: 'shut', Condition: { Operator: 'Equals', Operands: ['true'] } },
            { NextAction: 'emergency?', Condition: { Operator: 'Equals', Operands: ['false'] } },
          ],
        },
      },
      {
        Identifier: 'shut',
        Type: 'MessageParticipant',
        Parameters: { Text: 'We are closed today' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'emergency?',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.Attributes.isEmergency' },
        Transitions: {
          NextAction: 'welcome',
          Conditions: [
            { NextAction: 'emergency', Condition: { Operator: 'Equals', Operands: ['true'] } },
            { NextAction: 'welcome', Condition: { Operator: 'Equals', Operands: ['false'] } },
          ],
        },
      },
      {
        Identifier: 'emergency',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Notice: $.Attributes.emergencyMessage' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome, we are open' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  const items = generateTestCases(
    { flow, defaults: DEFAULTS },
    {
      flowName: 'Config-Flow',
      externalValues: {
        isClosed: ['true', 'false'],
        isEmergency: ['true', 'false'],
        emergencyMessage: 'The lines are down today',
      },
      warn: () => {},
    }
  );

  it('covers each branch once, not once per answer it never reads', () => {
    // Closed is heard the same whatever the emergency flag says, because the flow
    // has already hung up by the time anything reads it. Four combinations, three
    // calls: 2x2 minus the one the closed path would have been generated twice for.
    expect(Object.keys(items).sort()).toEqual([
      'isClosed-false.isEmergency-false',
      'isClosed-false.isEmergency-true',
      'isClosed-true',
    ]);
  });

  it('names a test case for the flag it turns on, not just its value', () => {
    // "true.false" would leave nothing to say which flag was which.
    expect(messages(items['isClosed-true'])).toEqual(['We are closed today']);
    expect(messages(items['isClosed-false.isEmergency-true'])).toEqual([
      'Notice: The lines are down today',
    ]);
    expect(messages(items['isClosed-false.isEmergency-false'])).toEqual(['Welcome, we are open']);
  });

  it('names them the same however the sidecar orders its keys', () => {
    // The label order is the key order, not the file's order: the name is the sort key
    // the results are read by, so adding or removing one key must not rename every
    // other key's test cases.
    const reversed = generateTestCases(
      { flow, defaults: DEFAULTS },
      {
        flowName: 'Config-Flow',
        externalValues: {
          emergencyMessage: 'The lines are down today',
          isEmergency: ['true', 'false'],
          isClosed: ['true', 'false'],
        },
        warn: () => {},
      }
    );

    expect(Object.keys(reversed).sort()).toEqual(Object.keys(items).sort());
  });

  it('mocks none of them, however many answers are declared', () => {
    for (const item of Object.values(items)) {
      expect(item.lambda_mocks).toBeUndefined();
    }
  });
});

// The block that compares an attribute can be several copies removed from the answer
// it came from, and the export lists blocks in no particular order - so which answers
// an attribute could hold is worked out by going round the blocks until nothing new
// is learnt, rather than in one pass.
describe('a flow that copies one attribute out of another', () => {
  const LAMBDA = 'arn:aws:lambda:af-south-1:111122223333:function:call-config';

  const flow = {
    Version: '2019-10-30',
    StartAction: 'look-up',
    Metadata: { name: 'Chain-Flow' },
    // Listed with the second copy before the first, which is the order that catches a
    // single pass: "mode" is only known to hold the answer once "raw" is.
    Actions: [
      {
        Identifier: 'rename',
        Type: 'UpdateContactAttributes',
        Parameters: { Attributes: { mode: '$.Attributes.raw' } },
        Transitions: { NextAction: 'mode?' },
      },
      {
        Identifier: 'look-up',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: LAMBDA },
        Transitions: { NextAction: 'store' },
      },
      {
        Identifier: 'store',
        Type: 'UpdateContactAttributes',
        Parameters: { Attributes: { raw: '$.External.callMode' } },
        Transitions: { NextAction: 'rename' },
      },
      {
        Identifier: 'mode?',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.Attributes.mode' },
        Transitions: {
          NextAction: 'anything-else',
          Conditions: [
            { NextAction: 'by-voice', Condition: { Operator: 'Equals', Operands: ['voice'] } },
            { NextAction: 'by-chat', Condition: { Operator: 'Equals', Operands: ['chat'] } },
          ],
        },
      },
      {
        Identifier: 'by-voice',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Thank you for calling' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'by-chat',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Thank you for your message' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'anything-else',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Thank you for getting in touch' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  const items = generateTestCases({ flow, defaults: DEFAULTS }, { flowName: 'Chain-Flow', warn: () => {} });

  it('covers every branch of the block two copies away from the answer', () => {
    expect(Object.keys(items).sort()).toEqual(['callMode-unset', 'chat', 'voice']);
    expect(messages(items['voice'])).toEqual(['Thank you for calling']);
    expect(messages(items['chat'])).toEqual(['Thank you for your message']);
    expect(messages(items['callMode-unset'])).toEqual(['Thank you for getting in touch']);
  });

});

// A branch of a "Check contact attributes" block does not have to play anything: a
// decommissioned number is hung up on in silence. Nothing is heard, so there is
// nothing an execution could observe - and Connect will not accept a test case that
// only says where the flow ended. CreateTestCase answers 400
// InvalidTestCaseException, "InvalidEventProblem(observationIdentifier=flow_ended,
// reason=Invalid action type for FlowActionStarted event)", which is how this was
// found: a real upload lost one test case to it and, because the create threw, the
// records beside it in the stream batch were delivered and run twice. So a silent
// branch is skipped, and the report says what would make it assertable.
describe('a branch that ends the call in silence', () => {
  const LAMBDA = 'arn:aws:lambda:af-south-1:111122223333:function:call-config';

  const flow = {
    Version: '2019-10-30',
    StartAction: 'look-up',
    Metadata: { name: 'Silent-Flow' },
    Actions: [
      {
        Identifier: 'look-up',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: LAMBDA },
        Transitions: { NextAction: 'store' },
      },
      {
        Identifier: 'store',
        Type: 'UpdateContactAttributes',
        Parameters: { Attributes: { dicommisioned: '$.External.dicommisioned' } },
        Transitions: { NextAction: 'live?' },
      },
      // Wired the way the real flow is: no matching condition goes where "true" goes,
      // so there are two branches to cover here rather than three.
      {
        Identifier: 'live?',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.Attributes.dicommisioned' },
        Transitions: {
          NextAction: 'stop',
          Conditions: [
            { NextAction: 'stop', Condition: { Operator: 'Equals', Operands: ['true'] } },
            { NextAction: 'hours', Condition: { Operator: 'Equals', Operands: ['false'] } },
          ],
        },
      },
      // Only the live branch checks the hours, so it is the only one with an id to
      // read off - and the silent branch's test case still needs one.
      {
        Identifier: 'hours',
        Type: 'CheckHoursOfOperation',
        Parameters: { HoursOfOperationId: 'hoo-open' },
        Transitions: {
          NextAction: 'welcome',
          Conditions: [{ NextAction: 'stop', Condition: { Operator: 'Equals', Operands: ['False'] } }],
        },
      },
      {
        Identifier: 'welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome, we are open' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'stop', Type: 'EndFlowExecution', Parameters: {}, Transitions: {} },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  const warnings: string[] = [];
  const items = generateTestCases(
    // No hours of operation declared: the flow's own block is the only source, and
    // the silent path never reaches it.
    { flow, defaults: { caller_number: '+27100000000', hours_of_operation_results: 'InHour' } },
    {
      flowName: 'Silent-Flow',
      externalValues: { dicommisioned: ['false', 'true'] },
      warn: (message) => warnings.push(message),
    }
  );

  it('is left out, because there would be nothing in it', () => {
    // Only the branches that say something. Out of hours ends the call in silence
    // too, and only on the live branch: the decommissioned one has already ended
    // before anything checks the hours.
    expect(Object.keys(items).sort()).toEqual(['dicommisioned-false']);
  });

  it('says which block the flow ended on, so the branch can be given a prompt', () => {
    const skipped = warnings.filter((message) => message.includes('skipping it'));
    expect(skipped).toHaveLength(2);
    for (const label of ['dicommisioned-true', 'OutOfHour.dicommisioned-false']) {
      expect(warnings.join('\n')).toContain(
        `Path ${label} reaches EndFlowExecution without a prompt this test case could assert`
      );
    }
    // And why, rather than only that it happened.
    expect(warnings.join('\n')).toContain('Connect rejects a test case that only says where the flow ended');
  });

  it('covers the other branch of the same invocation as well', () => {
    expect(messages(items['dicommisioned-false'])).toEqual(['Welcome, we are open']);
    expect(items['dicommisioned-false'].hours_of_operation).toBe('hoo-open');
    expect(items['dicommisioned-false'].lambda_mocks).toBeUndefined();
  });
});

// A block comparing an attribute has one more branch than it has conditions: the one
// Connect takes when none of them match. Nothing the function can answer with takes
// it - what takes it is the function not answering at all, because an attribute set
// from a key the response left out is empty and equals none of the conditions.
describe('the answer the function does not give', () => {
  const LAMBDA = 'arn:aws:lambda:af-south-1:111122223333:function:call-config';

  const flow = {
    Version: '2019-10-30',
    StartAction: 'look-up',
    Metadata: { name: 'Unset-Flow' },
    Actions: [
      {
        Identifier: 'look-up',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: LAMBDA },
        Transitions: { NextAction: 'store' },
      },
      {
        Identifier: 'store',
        Type: 'UpdateContactAttributes',
        Parameters: {
          Attributes: {
            isEmergency: '$.External.isEmergency',
            emergencyMessage: '$.External.emergencyMessage',
          },
        },
        Transitions: { NextAction: 'emergency?' },
      },
      // Three destinations, so three branches: the no-match one skips the consent
      // notice the "false" one plays.
      {
        Identifier: 'emergency?',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.Attributes.isEmergency' },
        Transitions: {
          NextAction: 'welcome',
          Conditions: [
            { NextAction: 'notice', Condition: { Operator: 'Equals', Operands: ['true'] } },
            { NextAction: 'consent', Condition: { Operator: 'Equals', Operands: ['false'] } },
          ],
        },
      },
      {
        Identifier: 'notice',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Notice: $.Attributes.emergencyMessage' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'consent',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Your call may be recorded' },
        Transitions: { NextAction: 'welcome' },
      },
      {
        Identifier: 'welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome, we are open' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  // `isEmergency` left out declares nothing for the key the flow branches on, which is
  // how a sidecar written by hand tends to look.
  const generateWith = (isEmergency?: unknown, coverBranchValues?: boolean) => {
    const warnings: string[] = [];
    const external: Record<string, string | string[]> = {
      emergencyMessage: 'The lines are down today',
    };
    if (isEmergency !== undefined) external.isEmergency = isEmergency as string | string[];
    const items = generateTestCases(
      { flow, defaults: DEFAULTS },
      {
        flowName: 'Unset-Flow',
        externalValues: external,
        coverBranchValues,
        warn: (message) => warnings.push(message),
      }
    );
    return { items, warnings };
  };

  describe('declared as null alongside the answers it does give', () => {
    const { items, warnings } = generateWith(['true', 'false', null]);

    it('covers the branch no answer takes, named for the key rather than a value', () => {
      expect(Object.keys(items).sort()).toEqual([
        'isEmergency-false',
        'isEmergency-true',
        'isEmergency-unset',
      ]);
      expect(warnings).toEqual([]);
    });

    it('takes the branch Connect takes when nothing matches', () => {
      // The consent notice is on the "false" branch, and skipping it is the whole
      // difference between that branch and this one.
      expect(messages(items['isEmergency-unset'])).toEqual(['Welcome, we are open']);
      expect(messages(items['isEmergency-false'])).toEqual([
        'Your call may be recorded',
        'Welcome, we are open',
      ]);
      expect(messages(items['isEmergency-true'])).toEqual(['Notice: The lines are down today']);
    });

    it('asserts the branch without answering the invocation at all', () => {
      // This branch is the one the flow takes when the response leaves the key out,
      // and nothing seeds that - it is what the real function does or does not do.
      expect(items['isEmergency-unset'].lambda_mocks).toBeUndefined();
      expect(items['isEmergency-false'].lambda_mocks).toBeUndefined();
    });
  });

  describe('not declared at all, and only reachable through a contact attribute', () => {
    const { items, warnings } = generateWith();

    it('covers all three branches off the block that compares the attribute', () => {
      // Nothing names this key. The block that decides on it names two of its values
      // and, by having a third destination, the absence of both - and the flow copies
      // it out of the Lambda's answer several blocks earlier, which is what ties the
      // three back to something a test case can set.
      expect(Object.keys(items).sort()).toEqual([
        'isEmergency-false',
        'isEmergency-true',
        'isEmergency-unset',
      ]);
      expect(warnings).toEqual([]);
      expect(messages(items['isEmergency-unset'])).toEqual(['Welcome, we are open']);
    });

  });

  describe('one answer declared, with covering every branch turned off', () => {
    const { warnings } = generateWith('false', false);

    it('says which block and which branch nothing covered, and what would', () => {
      const report = warnings.filter((message) => message.includes('never taken'));
      expect(report).toHaveLength(1);
      expect(report[0]).toContain('$.Attributes.isEmergency');
      // Two of three: the emergency notice and the branch nothing matches.
      expect(report[0]).toContain('2 of its 3 branches were never taken');
      expect(report[0]).toContain('"Equals true"');
      expect(report[0]).toContain('"no matching condition"');
      // A branch that is never taken is never tested, and neither the block nor the
      // branch appears anywhere in the generated test cases - so the warning is the
      // only place the gap can be seen, and it says how to close it.
      expect(report[0]).toContain('null');
    });
  });
});

// Reading the values off a block works because a condition like "equals gold" names
// the answer that takes it. A range does not: nothing in "greater than a thousand"
// says which number to answer with, and guessing one would put a test case's whole
// assertion on a guess. So that branch is reported instead, for a person to declare.
describe('a branch chosen by a comparison no single value inverts', () => {
  const LAMBDA = 'arn:aws:lambda:af-south-1:111122223333:function:balance';

  const flow = {
    Version: '2019-10-30',
    StartAction: 'look-up',
    Metadata: { name: 'Range-Flow' },
    Actions: [
      {
        Identifier: 'look-up',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: LAMBDA },
        Transitions: { NextAction: 'how-much' },
      },
      {
        Identifier: 'how-much',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.External.balanceAmount' },
        Transitions: {
          NextAction: 'ordinary',
          Conditions: [
            {
              NextAction: 'premium',
              Condition: { Operator: 'NumberGreaterThan', Operands: ['1000'] },
            },
            { NextAction: 'empty', Condition: { Operator: 'NumberEquals', Operands: ['0'] } },
          ],
        },
      },
      {
        Identifier: 'premium',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome to premium banking' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'empty',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Your account is empty' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'ordinary',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome to the bank' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  const warnings: string[] = [];
  const items = generateTestCases(
    { flow, defaults: DEFAULTS },
    { flowName: 'Range-Flow', warn: (message) => warnings.push(message) }
  );

  it('covers the branches a value does name, and only those', () => {
    expect(Object.keys(items).sort()).toEqual([
      'balanceAmount-0',
      'balanceAmount-unset',
    ]);
    expect(messages(items['balanceAmount-0'])).toEqual(['Your account is empty']);
    // Not the empty account: an attribute the function answered nothing for has no
    // number to compare, so it matches the zero branch no more than any other.
    expect(messages(items['balanceAmount-unset'])).toEqual(['Welcome to the bank']);
  });

  it('says which branch is left for a person to declare a value for', () => {
    const report = warnings.filter((message) => message.includes('never taken'));
    expect(report).toHaveLength(1);
    expect(report[0]).toContain('$.External.balanceAmount');
    expect(report[0]).toContain('1 of its 3 branches was never taken: "NumberGreaterThan 1000"');
  });
});

// A block that names its function only at runtime used to be the one case nothing
// could be mocked in. Nothing is mocked anywhere now, so it is no different to any
// other invocation - except that there is no name to call a failure test case after.
describe('a flow that names its Lambda only at runtime', () => {
  const dynamicFlow = {
    ...bankFlow,
    Actions: bankFlow.Actions.map((action) =>
      action.Identifier === 'look-up'
        ? { ...action, Parameters: { LambdaFunctionARN: '$.Attributes.lookupArn' } }
        : action
    ),
  };

  const warnings: string[] = [];
  const items = generateTestCases(
    { flow: dynamicFlow, defaults: DEFAULTS },
    {
      flowName: 'BM-Test-Lambda-Flow',
      externalValues: { customerType: 'standard', balance: 'R1 250.00' },
      warn: (message) => warnings.push(message),
    }
  );

  it('still asserts the declared values', () => {
    expect(messages(items['1.standard']).at(-1)).toBe('R1 250.00');
  });

  it('covers the same branches as a block that names its function', () => {
    // There is nothing left for a runtime-named function to miss out on: every
    // invocation is the real one, so this flow is tested exactly like any other.
    expect(Object.keys(items).sort()).toEqual([
      '1.customerType-unset',
      '1.gold',
      '1.standard',
      '2',
      'Default',
      'Timeout',
    ]);
    expect(items['1.standard'].lambda_mocks).toBeUndefined();
    expect(items['1.gold'].lambda_mocks).toBeUndefined();
    expect(warnings.join(' ')).not.toContain('mock');
  });
});

// A flow can read one function's answer and then another's - each invocation
// replaces $.External. Both run for real, so both answers are asserted where they
// are played back, and neither invocation is seeded with anything.
describe('a flow that invokes two functions', () => {
  const CONFIG_ARN = 'arn:aws:lambda:af-south-1:111122223333:function:call-config';
  const LOOKUP_ARN = 'arn:aws:lambda:af-south-1:111122223333:function:get-cust-ref';

  const twoFlow = {
    Version: '2019-10-30',
    StartAction: 'config',
    Metadata: { name: 'BM-Two-Lambdas' },
    Actions: [
      {
        Identifier: 'config',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: CONFIG_ARN },
        Transitions: { NextAction: 'greet' },
      },
      {
        Identifier: 'greet',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome to $.External.brand' },
        Transitions: { NextAction: 'keep-hours' },
      },
      // Read through an attribute rather than straight off $.External, which is what
      // the real flows do - the key still belongs to the function that answered it.
      {
        Identifier: 'keep-hours',
        Type: 'UpdateContactAttributes',
        Parameters: { Attributes: { open_until: '$.External.closesAt' }, TargetContact: 'Current' },
        Transitions: { NextAction: 'say-hours' },
      },
      {
        Identifier: 'say-hours',
        Type: 'MessageParticipant',
        Parameters: { Text: 'We are open until $.Attributes.open_until' },
        Transitions: { NextAction: 'look-up' },
      },
      {
        Identifier: 'look-up',
        Type: 'InvokeLambdaFunction',
        Parameters: { LambdaFunctionARN: LOOKUP_ARN },
        Transitions: { NextAction: 'check' },
      },
      {
        Identifier: 'check',
        Type: 'Compare',
        Parameters: { ComparisonValue: '$.External.auth_number' },
        Transitions: {
          NextAction: 'unknown',
          Conditions: [
            { NextAction: 'found', Condition: { Operator: 'Equals', Operands: ['24680'] } },
          ],
        },
      },
      {
        Identifier: 'found',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Reference $.External.auth_number, please hold' },
        Transitions: { NextAction: 'hangup' },
      },
      {
        Identifier: 'unknown',
        Type: 'MessageParticipant',
        Parameters: { Text: 'We could not authorise that reference' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  const items = generateTestCases(
    { flow: twoFlow, defaults: DEFAULTS },
    {
      flowName: 'BM-Two-Lambdas',
      externalValues: { brand: 'the bank', closesAt: 'five', auth_number: '24680' },
      warn: () => undefined,
    }
  );

  it('names a test case for each branch of the check', () => {
    expect(Object.keys(items).sort()).toEqual(['auth_number-24680', 'auth_number-unset']);
  });

  it('asserts both functions answers, and mocks neither', () => {
    expect(messages(items['auth_number-24680'])).toEqual([
      'Welcome to the bank',
      'We are open until five',
      'Reference 24680, please hold',
    ]);
    expect(items['auth_number-24680'].lambda_mocks).toBeUndefined();
    expect(items['auth_number-unset'].lambda_mocks).toBeUndefined();
  });
});

describe('externalVariants', () => {
  it('is one set when every key has a single value', () => {
    expect(externalVariants({ balance: 'R1 250.00' }, () => {})).toEqual([
      { labels: [], values: new Map([['balance', 'R1 250.00']]), fanned: [] },
    ]);
  });

  it('crosses the keys that have several', () => {
    const variants = externalVariants(
      { customerType: ['gold', 'standard'], language: ['en', 'af'] },
      () => {}
    );

    expect(variants.map((variant) => variant.labels.join('.'))).toEqual([
      'gold.en',
      'gold.af',
      'standard.en',
      'standard.af',
    ]);
    expect(variants[0].fanned).toEqual(['customerType', 'language']);
  });

  it('walks every value once instead of crossing them, past the cap, and says it did', () => {
    const warnings: string[] = [];
    // Five keys with three answers each is 243 walks of the flow, past the 32 the
    // default cap allows.
    const variants = externalVariants(
      {
        a: ['1', '2', '3'],
        b: ['1', '2', '3'],
        c: ['1', '2', '3'],
        d: ['1', '2', '3'],
        e: ['1', '2', '3'],
      },
      (message) => warnings.push(message)
    );

    // The first answer to everything, then each of the other answers against it:
    // eleven walks that between them use all fifteen values. Cutting the cross
    // product off at the cap cannot promise that - it drops whole values of the
    // keys it fans last, and a branch only those values take goes with them.
    expect(variants.map((variant) => variant.labels.join('.'))).toEqual([
      'a-1.b-1.c-1.d-1.e-1',
      'a-2.b-1.c-1.d-1.e-1',
      'a-3.b-1.c-1.d-1.e-1',
      'a-1.b-2.c-1.d-1.e-1',
      'a-1.b-3.c-1.d-1.e-1',
      'a-1.b-1.c-2.d-1.e-1',
      'a-1.b-1.c-3.d-1.e-1',
      'a-1.b-1.c-1.d-2.e-1',
      'a-1.b-1.c-1.d-3.e-1',
      'a-1.b-1.c-1.d-1.e-2',
      'a-1.b-1.c-1.d-1.e-3',
    ]);
    expect(warnings.join('\n')).toContain('MAX_EXTERNAL_VARIANTS');
  });

  it('keeps the answer no condition matches, past the cap', () => {
    // The shape the real flow has: one key the flow branches on three ways, and
    // four flags. 48 combinations, so the cross product is cut off - and what fell
    // off the end was every set holding the answer that matches no condition,
    // which is the one the "no matching condition" branch needs.
    const variants = externalVariants(
      {
        auth_number: ['AUTH123456', '24680', null as unknown as string],
        dicommisioned: ['false', 'true'],
        isInHoursEmergency: ['false', 'true'],
        isOutOfHoursEmergency: ['false', 'true'],
        isHoliday: ['false', 'true'],
      },
      () => {}
    );

    expect(variants.some((variant) => variant.values.get('auth_number') === '')).toBe(true);
  });

  it('ignores what no prompt could play back, and says which key', () => {
    const warnings: string[] = [];
    const variants = externalVariants(
      { balance: { amount: 42 } as unknown as string, customerType: 'gold' },
      (message) => warnings.push(message)
    );

    expect(variants).toEqual([
      { labels: [], values: new Map([['customerType', 'gold']]), fanned: [] },
    ]);
    expect(warnings.join('\n')).toContain('balance');
  });

  it('takes a flag or a number written as one, which a contact attribute is not', () => {
    // "dicommisioned": false is what a "Check contact attributes" block compares
    // against, so writing it as JSON rather than as text is not a mistake to
    // report - Connect has no attribute that is not text.
    const warnings: string[] = [];
    const variants = externalVariants(
      {
        dicommisioned: false as unknown as string,
        retries: 3 as unknown as string,
        isEmergency: [true, false] as unknown as string[],
      },
      (message) => warnings.push(message)
    );

    expect(warnings).toEqual([]);
    // Named for the flag as well as the value: "true" alone would say nothing about
    // which of a flow's several flags this test case turns on.
    expect(variants.map((variant) => variant.labels.join('.'))).toEqual([
      'isEmergency-true',
      'isEmergency-false',
    ]);
    expect(variants[0].values).toEqual(
      new Map([
        ['dicommisioned', 'false'],
        ['retries', '3'],
        ['isEmergency', 'true'],
      ])
    );
  });
});

describe('withBranchValues', () => {
  it('adds what the blocks compare against to what was declared', () => {
    expect(
      withBranchValues({ customerType: 'standard' }, { customerType: ['gold', 'standard'] })
    ).toEqual({ customerType: ['standard', 'gold'] });
  });

  it('keeps a declared answer no block compares against', () => {
    // The balance is played back, never branched on: the only thing that knows it is
    // the declaration, and losing it would lose the words the prompt asserts.
    expect(withBranchValues({ balance: 'R1 250.00' }, { customerType: ['gold'] })).toEqual({
      balance: 'R1 250.00',
      customerType: ['gold'],
    });
  });

  it('does not walk the same answer twice for being written two ways', () => {
    // A flag declared as JSON and compared as text is one answer, not two.
    expect(withBranchValues({ dicommisioned: false as unknown as string }, {
      dicommisioned: ['false', 'true'],
    })).toEqual({ dicommisioned: [false, 'true'] });
  });

  it('is nothing at all when neither says anything', () => {
    expect(withBranchValues(undefined, {})).toBeUndefined();
    expect(withBranchValues(undefined, { customerType: ['gold'] })).toEqual({
      customerType: ['gold'],
    });
  });
});

describe('mergeExternalValues', () => {
  it('lets the sidecar win over the definition, which is re-exported', () => {
    expect(
      mergeExternalValues(
        { external: { customerType: 'gold', balance: 'R0.00' } },
        { balance: 'R1 250.00' }
      )
    ).toEqual({ customerType: 'gold', balance: 'R1 250.00' });
  });

  it('is whatever exists when only one of the two does', () => {
    expect(mergeExternalValues({}, { balance: 'R1 250.00' })).toEqual({ balance: 'R1 250.00' });
    expect(mergeExternalValues({ external_values: { balance: 'R0.00' } }, undefined)).toEqual({
      balance: 'R0.00',
    });
    expect(mergeExternalValues({}, undefined)).toBeUndefined();
  });
});

describe('the declared values sidecar key', () => {
  it('is named for the flow it declares values for', () => {
    expect(valuesFlowName('flow-definition/BM-Test-IaC-Flow.values.json')).toBe('BM-Test-IaC-Flow');
    expect(valuesKey('BM-Test-IaC-Flow')).toBe('flow-definition/BM-Test-IaC-Flow.values.json');
    expect(definitionKey('BM-Test-IaC-Flow')).toBe('flow-definition/BM-Test-IaC-Flow.json');
  });

  it('is not a flow definition', () => {
    expect(valuesFlowName('flow-definition/BM-Test-IaC-Flow.json')).toBeUndefined();
    // Read as one it would generate a config for a flow called
    // "BM-Test-IaC-Flow.values", and deleting it would tear down the real flow's
    // test cases.
    expect(() => flowNameFromKey('flow-definition/BM-Test-IaC-Flow.values.json')).toThrow(
      'flow-definition/BM-Test-IaC-Flow.json'
    );
  });
});
