// A "Store customer input" block is not a menu: it offers no options, so there is
// nothing to branch on - but it does wait for digits, and what the caller types
// there is read back later as $.StoredCustomerInput. A test case that sends
// nothing sits there until the block gives up, so what it sends has to come from
// somewhere; where, is the subject here.

import { generateTestCases, mergeStoredInputs } from '../lambda/flow-test-cases-gen';

const DEFAULTS = {
  caller_number: '+1234567890',
  hours_of_operation: '4605e369-8882-44d8-a3e9-069bb7fb7120',
  hours_of_operation_results: 'InHour',
};

type Block = {
  Observe: { message: string };
  Action?: { type: string; user_action: string };
  next?: string;
};

// Walks the generated config the way universal-test-cases-gen does, so a broken
// chain fails here rather than at test case creation time.
function chain(item: Record<string, any>): Block[] {
  const blocks: Block[] = [];
  const seen = new Set<string>();
  let name: string | undefined = 'welcome_message';

  while (name) {
    expect(seen.has(name)).toBe(false);
    seen.add(name);
    expect(item[name]).toBeDefined();
    const block = item[name] as Block;
    blocks.push(block);
    name = block.next;
  }

  return blocks;
}

const messages = (item: Record<string, any>): string[] =>
  chain(item).map((block) => block.Observe.message);

// The digits sent at the input block: the first block of the path with anything
// to send.
const typed = (item: Record<string, any>) => chain(item).find((block) => block.Action)?.Action;

const STORE_BLOCK = '42d869d3-f6e3-4f60-aac3-be2079efcfdb';

// The sales sub-flow of BM-Test-IaC-Flow, cut down to the part that collects a
// reference number and reads it back: enter the number, keep it as an attribute,
// play it back for confirmation.
const salesFlow = () => ({
  Version: '2019-10-30',
  StartAction: 'welcome',
  Metadata: { name: 'BM-Sales-Input' },
  Actions: [
    {
      Identifier: 'welcome',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Welcome to sales.' },
      Transitions: { NextAction: STORE_BLOCK },
    },
    {
      Identifier: STORE_BLOCK,
      Type: 'GetParticipantInput',
      Parameters: {
        Text: 'Please enter your reference number for the sale',
        StoreInput: 'True',
        InputValidation: { CustomValidation: { MaximumLength: '20' } },
      },
      Transitions: {
        NextAction: 'keep_number',
        Errors: [{ ErrorType: 'NoMatchingError', NextAction: 'keep_number' }],
      },
    },
    {
      Identifier: 'keep_number',
      Type: 'UpdateContactAttributes',
      Parameters: {
        Attributes: { sales_number: '$.StoredCustomerInput' },
        TargetContact: 'Current',
      },
      Transitions: { NextAction: 'confirm' },
    },
    {
      Identifier: 'confirm',
      Type: 'GetParticipantInput',
      Parameters: {
        Text: 'Your sales number entered is $.Attributes.sales_number. Press 1 to confirm.',
        StoreInput: 'False',
      },
      Transitions: {
        NextAction: 'goodbye',
        Conditions: [{ NextAction: 'thanks', Condition: { Operator: 'Equals', Operands: ['1'] } }],
      },
    },
    {
      Identifier: 'thanks',
      Type: 'MessageParticipant',
      Parameters: { Text: 'Thank you, transferring you now.' },
      Transitions: { NextAction: 'goodbye' },
    },
    { Identifier: 'goodbye', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
  ] as any[],
  ActionMetadata: {},
});

const actionIn = (flow: { Actions: any[] }, identifier: string) =>
  flow.Actions.find((action) => action.Identifier === identifier);

// The same flow, but with a block that branches on the number that was entered:
// the one thing digits the generator made up cannot be trusted to get right.
const checkingFlow = () => {
  const flow = salesFlow();
  actionIn(flow, 'keep_number').Transitions = { NextAction: 'is_known' };
  flow.Actions.push(
    {
      Identifier: 'is_known',
      Type: 'Compare',
      Parameters: { ComparisonValue: '$.Attributes.sales_number' },
      Transitions: {
        NextAction: 'not_found',
        Conditions: [
          { NextAction: 'found', Condition: { Operator: 'Equals', Operands: ['5551234'] } },
        ],
      },
    },
    {
      Identifier: 'found',
      Type: 'MessageParticipant',
      Parameters: { Text: 'That order is on its way.' },
      Transitions: { NextAction: 'goodbye' },
    },
    {
      Identifier: 'not_found',
      Type: 'MessageParticipant',
      Parameters: { Text: 'We could not find that number.' },
      Transitions: { NextAction: 'goodbye' },
    }
  );
  return flow;
};

// The same flow, but the confirmation menu offers a second go at the number, the
// way the real one does: through a Loop block, so the flow gives up after two.
const reenteringFlow = () => {
  const flow = salesFlow();
  actionIn(flow, 'confirm').Transitions.Conditions.push({
    NextAction: 'again',
    Condition: { Operator: 'Equals', Operands: ['2'] },
  });
  flow.Actions.push({
    Identifier: 'again',
    Type: 'Loop',
    Parameters: { LoopCount: '2' },
    Transitions: {
      NextAction: 'goodbye',
      Conditions: [
        { NextAction: STORE_BLOCK, Condition: { Operator: 'Equals', Operands: ['ContinueLooping'] } },
        { NextAction: 'goodbye', Condition: { Operator: 'Equals', Operands: ['DoneLooping'] } },
      ],
    },
  });
  return flow;
};

const generate = (
  flow: unknown,
  storedInputs?: Record<string, string>,
  paths?: string[]
) => {
  const warnings: string[] = [];
  const items = generateTestCases(flow, {
    flowName: 'BM-Sales-Input',
    defaults: DEFAULTS,
    storedInputs,
    paths,
    warn: (m) => warnings.push(m),
  });
  return { items, warnings };
};

const askedFor = (warnings: string[]) =>
  warnings.filter((message) => message.includes('stores what the caller types'));

describe('what a test case types at a "Store customer input" block', () => {
  it('is digits of the generator\'s own when nothing says what the caller types', () => {
    const { items } = generate(salesFlow());

    expect(typed(items['1'])).toEqual({ type: 'DtmfInput', user_action: '1234' });
    // And they are what the flow plays back, because here the test case is the
    // caller: whatever it types is what the flow really receives.
    expect(messages(items['1'])).toContain(
      'Your sales number entered is 1234. Press 1 to confirm.'
    );
  });

  it('is asked for by the name of the attribute the block feeds', () => {
    const { warnings } = generate(salesFlow());

    expect(askedFor(warnings)).toHaveLength(1);
    expect(askedFor(warnings)[0]).toContain('"stored_input": { "sales_number": "..." }');
  });

  it('is what the definition declares for that attribute', () => {
    const flow: any = salesFlow();
    flow.stored_input = { sales_number: '5551234' };
    const { items, warnings } = generate(flow);

    expect(typed(items['1'])).toEqual({ type: 'DtmfInput', user_action: '5551234' });
    expect(messages(items['1'])).toContain(
      'Your sales number entered is 5551234. Press 1 to confirm.'
    );
    expect(askedFor(warnings)).toHaveLength(0);
  });

  it('can be named by the block itself, for a value no attribute is given', () => {
    const { items } = generate(salesFlow(), { [STORE_BLOCK]: '9876' });

    expect(typed(items['1'])?.user_action).toBe('9876');
  });

  it('can be one value for every input block in the flow', () => {
    const flow: any = salesFlow();
    flow.stored_input = '0821234567';
    const { items } = generate(flow);

    expect(typed(items['1'])?.user_action).toBe('0821234567');
  });

  it('comes from the values file beside the definition ahead of the definition', () => {
    const flow: any = salesFlow();
    flow.stored_input = { sales_number: '5551234' };
    const { items } = generate(flow, { sales_number: '4442222' });

    expect(typed(items['1'])?.user_action).toBe('4442222');
  });

  it('stays within the maximum length the block allows', () => {
    const flow = salesFlow();
    actionIn(flow, STORE_BLOCK).Parameters.InputValidation = {
      CustomValidation: { MaximumLength: '2' },
    };
    const { items } = generate(flow);

    expect(typed(items['1'])?.user_action).toBe('12');
  });

  it('is what a block further down the flow branches on', () => {
    const { items } = generate(checkingFlow(), { sales_number: '5551234' });

    expect(messages(items['main'])).toContain('That order is on its way.');
  });

  it('takes whichever branch the generator\'s own digits match, and says so', () => {
    const { items, warnings } = generate(checkingFlow());

    expect(messages(items['main'])).toContain('We could not find that number.');
    expect(askedFor(warnings)[0]).toContain('a branch comparing them takes whichever way "1234"');
  });

  it('is played back where the prompt reads the stored input directly', () => {
    const flow = salesFlow();
    actionIn(flow, 'thanks').Parameters.Text =
      'Thank you, reference $.StoredCustomerInput is with the sales team.';
    const { items } = generate(flow, { sales_number: '5551234' });

    expect(messages(items['1'])).toContain('Thank you, reference 5551234 is with the sales team.');
  });

  it('is named as missing by a prompt that reads it where no block stored it', () => {
    const flow = salesFlow();
    actionIn(flow, 'welcome').Transitions = { NextAction: 'thanks' };
    actionIn(flow, 'thanks').Parameters.Text = '$.StoredCustomerInput';
    const { items, warnings } = generate(flow);

    expect(warnings.join('\n')).toContain('plays nothing but $.StoredCustomerInput');
    expect(warnings.join('\n')).toContain('"Store customer input" block earlier in the flow');
    expect(messages(items['main'])).toEqual(['Welcome to sales.']);
  });
});

// The number the flow wants is one of three things a caller does at an input
// block. The other two are the timeout and default test cases, and neither of
// them types that number - however plainly the definition declares it.
describe('what a test case types where the caller gets it wrong', () => {
  const ENTER = 'Please enter your reference number';

  const blockSaying = (item: Record<string, any>, fragment: string) =>
    chain(item).filter((block) => block.Observe.message.includes(fragment));

  const declaring = (value: string, flow = salesFlow()) => {
    const definition: any = flow;
    definition.stored_input = { sales_number: value };
    return generate(definition);
  };

  it('is nothing at all for the timeout test case', () => {
    const { items } = declaring('5551234');

    expect(blockSaying(items['Timeout.1'], ENTER)).toHaveLength(1);
    expect(blockSaying(items['Timeout.1'], ENTER)[0].Action).toBeUndefined();
  });

  it('leaves the flow reading back the word a timed-out block stores', () => {
    const { items } = declaring('5551234');

    // Not the declared number, and not an empty gap either: the block's own
    // documentation says a call with no input carries on down Success with
    // "Stored customer input" holding "Timeout".
    expect(messages(items['Timeout.1'])).toContain(
      'Your sales number entered is Timeout. Press 1 to confirm.'
    );
  });

  it('is a number the flow was not asking for, for the default test case', () => {
    const { items } = declaring('5551234');

    expect(blockSaying(items['Default.1'], ENTER)[0].Action).toEqual({
      type: 'DtmfInput',
      user_action: '9999',
    });
    expect(messages(items['Default.1'])).toContain(
      'Your sales number entered is 9999. Press 1 to confirm.'
    );
  });

  it('shares no digit with the number the flow wants, so no branch matches it by accident', () => {
    const { items } = declaring('9876');

    expect(blockSaying(items['Default.1'], ENTER)[0].Action?.user_action).toBe('0000');
  });

  it('stays within the maximum length the block allows', () => {
    const flow = salesFlow();
    actionIn(flow, STORE_BLOCK).Parameters.InputValidation = {
      CustomValidation: { MaximumLength: '2' },
    };
    const { items } = declaring('12', flow);

    expect(blockSaying(items['Default.1'], ENTER)[0].Action?.user_action).toBe('99');
  });

  it('names the block for what the caller did there', () => {
    const { items } = declaring('5551234');

    expect(Object.keys(items['Timeout.1']).some((name) => name.startsWith('timeout_'))).toBe(true);
    expect(Object.keys(items['Default.1']).some((name) => name.startsWith('default_'))).toBe(true);
  });

  it('still types the declared number where the timeout is at a later block', () => {
    const { items } = declaring('5551234');

    // The exit belongs to the block it happens at: this one times out at the
    // confirmation menu, which the caller only reaches by entering the number.
    expect(blockSaying(items['Timeout'], ENTER)[0].Action?.user_action).toBe('5551234');
  });

  it('does the same thing again every time the flow loops back to the block', () => {
    const { items } = declaring('5551234', reenteringFlow());

    // The Loop offers the block twice more after the first go, and the test case
    // takes both: a loop is run out to the pass the flow has no more of, because
    // where it goes then is the branch the loop exists for. None of the three goes
    // types anything - the caller who said nothing goes on saying nothing - and none
    // of them branches off three more test cases.
    expect(blockSaying(items['Timeout.2'], ENTER)).toHaveLength(3);
    for (const block of blockSaying(items['Timeout.2'], ENTER)) {
      expect(block.Action).toBeUndefined();
    }

    // Every pass presses 2 again, as the caller did the first time.
    const pressed = blockSaying(items['Timeout.2'], 'Press 1 to confirm');
    expect(pressed).toHaveLength(3);
    for (const block of pressed) {
      expect(block.Action).toEqual({ type: 'DtmfInput', user_action: '2' });
    }
    expect(Object.keys(items).filter((name) => name.startsWith('Timeout.2.'))).toEqual([]);

    // And then the loop is spent, so the path ends where DoneLooping sends it rather
    // than at a block it has already been to.
    expect(items['Timeout.2'].description).toContain('(disconnected)');
  });

  it('is what a menu block that stores what was pressed leaves stored', () => {
    const flow = salesFlow();
    actionIn(flow, 'confirm').Parameters.StoreInput = 'True';
    actionIn(flow, 'thanks').Parameters.Text = 'You pressed $.StoredCustomerInput.';
    actionIn(flow, 'confirm').Transitions.Errors = [
      { ErrorType: 'InputTimeLimitExceeded', NextAction: 'thanks' },
      { ErrorType: 'NoMatchingCondition', NextAction: 'thanks' },
    ];
    const { items } = declaring('5551234', flow);

    expect(messages(items['Timeout'])).toContain('You pressed Timeout.');
    expect(messages(items['Default'])).toContain('You pressed 9.');
  });
});

// A flow can check the attribute the input block just filled, and then two steps of
// one call go by one name. Which of them a written path means is not a matter of
// counting dots: braces are what the caller typed, and a check block goes in as the
// value it read.
describe('naming a path where a check reads the attribute the input block filled', () => {
  const following = (...paths: string[]) =>
    generate(checkingFlow(), { sales_number: '5551234' }, paths);

  // What the test case has the call do, without the name and prose that say which
  // path it came from.
  const call = (item: any) => {
    const { description, 'testing-option': option, ...rest } = item ?? {};
    return rest;
  };

  it('reads the braces as the digits and the value beside them as the check', () => {
    const { items } = following('{sales_number}.sales_number-5551234');

    expect(Object.keys(items)).toEqual(['sales_number.sales_number-5551234']);
    expect(messages(items['sales_number.sales_number-5551234'])).toContain(
      'That order is on its way.'
    );
  });

  it('does not read the check as braces, however plainly it is that attribute', () => {
    expect(() => following('{sales_number}.{sales_number}')).toThrow(
      /braces are only ever the value the caller gave/
    );
  });

  it('stands in for the digits on the path that entered the number', () => {
    // And on no other: the timeout and the no-match are the caller getting it wrong
    // rather than entering a number, so they are named rather than stood in for. So a
    // path of nothing but the braces is the call that entered the number, exactly as a
    // full run makes it.
    const all = generate(checkingFlow(), { sales_number: '5551234' }).items;
    const { items } = following('{sales_number}');

    expect(Object.keys(all).length).toBeGreaterThan(1);
    expect(Object.keys(items)).toEqual(['sales_number']);
    expect(call(items['sales_number'])).toEqual(call(all['main']));
  });

  it('is that step by its name alone as well, so a test case name goes back in', () => {
    // A followed test case is named after the line that asked for it, less the braces,
    // so pasting that name back into "paths" has to follow the same call again.
    const named = Object.keys(following('{sales_number}.sales_number-5551234').items)[0];
    const { items } = following(named);

    expect(Object.keys(items)).toEqual([named]);
    expect(call(items[named])).toEqual(
      call(following('{sales_number}.sales_number-5551234').items[named])
    );
  });

  // The digits are declared once, in "stored_input". A check block reading them back is
  // written with the name of what declared them rather than with the digits, so the two
  // cannot drift apart when the declared number changes.
  describe('a step that refers to a declared value instead of repeating it', () => {
    it('reads it as the value the values file declares', () => {
      const referring = following('{sales_number}.sales_number-{sales_number}');
      const written = following('{sales_number}.sales_number-5551234');

      expect(Object.keys(referring.items)).toEqual(['sales_number.sales_number-5551234']);
      expect(call(referring.items['sales_number.sales_number-5551234'])).toEqual(
        call(written.items['sales_number.sales_number-5551234'])
      );
      expect(referring.warnings.join('\n')).toContain(
        'reads "{sales_number}" in the step "sales_number-{sales_number}" as "5551234"'
      );
    });

    it('says what is declared when the name is not', () => {
      expect(() => following('{sales_number}.sales_number-{order_number}')).toThrow(
        /refers to "\{order_number\}" and nothing declares order_number/
      );
      expect(() => following('{sales_number}.sales_number-{order_number}')).toThrow(
        /sales_number \(customer input\)/
      );
    });

    it('is a value, so the wildcard that is a whole step cannot be part of one', () => {
      expect(() => following('{sales_number}.sales_number-{any}')).toThrow(
        /"\{any\}" is a whole step of its own/
      );
    });
  });
});

describe('mergeStoredInputs', () => {
  const warn = () => undefined;

  it('reads a bare string as the value for every input block', () => {
    expect(mergeStoredInputs({ stored_input: '12345' }, undefined, warn)).toEqual({
      default: '12345',
    });
  });

  it('lowercases the keys, because one of them is an identifier out of an export', () => {
    expect(
      mergeStoredInputs({ stored_input: { '42D869D3-F6E3': '1' } }, undefined, warn)
    ).toEqual({ '42d869d3-f6e3': '1' });
  });

  it('takes numbers, which is what a reference number looks like unquoted', () => {
    expect(mergeStoredInputs({ stored_input: { sales_number: 12345 } }, undefined, warn)).toEqual({
      sales_number: '12345',
    });
  });

  it('says what it ignored', () => {
    const said: string[] = [];
    expect(
      mergeStoredInputs({ stored_input: { sales_number: { digits: 1 } } }, undefined, (m) =>
        said.push(m)
      )
    ).toBeUndefined();
    expect(said.join('\n')).toContain('only what a caller could actually type is usable');
  });

  it('lets the values file win key by key', () => {
    expect(
      mergeStoredInputs(
        { stored_input: { sales_number: '1', account: '2' } },
        { sales_number: '9' },
        warn
      )
    ).toEqual({ sales_number: '9', account: '2' });
  });
});
