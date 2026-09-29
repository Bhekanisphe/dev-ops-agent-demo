import * as fs from 'fs';
import * as path from 'path';
import {
  ConnectLookups,
  LexLookups,
  Utterances,
  flowNameFromKey,
  generateTestCases,
  generateTestCasesWithConnect,
  generatedKey,
  lexBotReferences,
  literalPromptText,
  resolveFlowDependencies,
  unresolvedFlowReferences,
  sanitizeLabel,
  speakableUtterance,
  testCaseNamePrefix,
  utteranceKey,
} from '../lambda/flow-test-cases-gen';

// What is actually deployed: the Amazon Connect export of BM-Test-IaC-Flow,
// exactly as it comes out of the designer. It names the module it invokes and the
// flow it sets as the customer queue flow without carrying either of them, so the
// copies the generator reads off the instance are kept beside it as fixtures -
// which is also what lets the bundle format be exercised without a second copy of
// the flow drifting away from this one.
const deployedExport = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'flow-definition', 'BM-Test-IaC-Flow.json'), 'utf-8')
);

// This suite is about the paths the flow itself has: the menus, the queues, the hours,
// the loops. Covering every branch of every block that compares what the Lambda
// answered walks each of those paths once per branch, which says nothing more about
// any of them and names every test case for flags they do not turn on - so it is off
// here, and has both its own suite and the two tests below that switch it back on.
process.env.COVER_BRANCH_VALUES = 'false';

// What the flow's Lambda answers, which no export says. Read from the file that is
// deployed beside the definition, so the two cannot drift apart - but with only the
// first of each key's values, which with the fan-out off is what pins each branching
// block to one branch.
const declaredValues = Object.fromEntries(
  Object.entries(
    JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'flow-definition', 'BM-Test-IaC-Flow.values.json'),
        'utf-8'
      )
    ).external as Record<string, string | string[]>
  ).map(([key, value]) => [key, Array.isArray(value) ? value[0] : value])
) as Record<string, string>;

// Taking only the first answer, which is what this suite does on purpose, leaves the
// other side of every flag the flow branches on untaken - and the generator says so,
// once per block. That report is the subject of its own test below; everywhere else it
// is the expected consequence of the values above, so it is set aside and whatever is
// left is a warning this suite means to be told about.
const isBranchCoverageWarning = (message: string) =>
  /branches on .+ and \d+ of its \d+ branches (was|were) never taken/.test(message);

const otherWarnings = (warnings: string[]) => warnings.filter((m) => !isBranchCoverageWarning(m));

const fixture = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf-8'));

const popiaModule = fixture('rsa-popiaAct.module.json');
const customerQueueFlow = fixture('default-customer-queue.flow.json');
// The queue flow the sales branch sets, which holds the caller with a message built
// from what the Lambda answered. Its name and id come from the export; its contents
// are a stand-in for the flow on the instance, written to say the one thing that
// matters here - that a hold message reads a declared value back.
const salesQueueFlow = fixture('rsa-default-cust-queue.flow.json');
// The flow BM-Test-IaC-Flow transfers to once a reference number is confirmed. The
// real export, deployed beside this one, for the same reason the definition above is
// read rather than copied.
const transferTargetFlow = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '..', 'flow-definition', 'BM-Test-Voice-IaC-Flow.json'),
    'utf-8'
  )
);

// The same flow with everything it reaches carried alongside it. Built fresh each
// time so a test that adds to it cannot change what the next one sees.
const deployedBundle = () => ({
  flow: deployedExport,
  modules: { 'rsa-popiaAct': popiaModule },
  flows: {
    'Default customer queue': customerQueueFlow,
    'rsa-default-cust-queue': salesQueueFlow,
    // The flow the confirmed-reference branch transfers to. Carried here because
    // generateTestCasesWithConnect reads it off the instance, so a test case really
    // does continue into it - a transfer names an entry point, not an end.
    'BM-Test-Voice-IaC-Flow': transferTargetFlow,
  },
  defaults: { customer_queue_flow: 'Default customer queue' },
  external: declaredValues,
  // What a caller says at the voice menu in the flow this one transfers to. On the
  // instance these come off the bot's sample utterances; nothing in an export
  // carries them, so they are declared here the way a definition would.
  utterances: {
    'bs-general': 'general enquiry',
    'bs-sales': 'sales',
    'bs-technical': 'technical support',
    'bs-technical-wifi': 'wifi',
    'bs-technical-laptop': 'laptop',
  },
});

// Only what a flow definition cannot supply. The queue is never configured:
// it always comes from the branch's own queue block.
const DEFAULTS = {
  caller_number: '+1234567890',
  hours_of_operation_results: 'InHour',
};

type Block = { Observe: { message: string }; Action?: { type: string; user_action: string }; next?: string };

// Walks a generated config the same way universal-test-cases-gen does, so a
// broken chain fails here instead of at test case creation time.
//
// check_queue is a step along the chain rather than the end of it: Connect starts
// the transfer before the customer queue flow speaks, so the hold messages come
// after it. It is the one step with no message of its own, so it contributes to
// where the chain goes but not to what is heard.
function walk(item: Record<string, any>): {
  names: string[];
  blocks: Block[];
  reachesQueue: boolean;
} {
  const names: string[] = [];
  const blocks: Block[] = [];
  const seen = new Set<string>();
  let name: string | undefined = 'welcome_message';
  let reachesQueue = false;

  while (name) {
    expect(seen.has(name)).toBe(false);
    seen.add(name);

    if (name === 'check_queue') {
      reachesQueue = true;
      // Nothing to say about the hold, so there is no entry for the transfer
      // either: the keyword in the last prompt's "next" is all of it, and the
      // test ends there.
      name = (item.check_queue as Block | undefined)?.next;
      continue;
    }

    expect(item[name]).toBeDefined();
    const block = item[name] as Block;
    names.push(name);
    blocks.push(block);
    name = block.next;
  }

  return { names, blocks, reachesQueue };
}

function chain(item: Record<string, any>): Block[] {
  return walk(item).blocks;
}

function messages(item: Record<string, any>): string[] {
  return chain(item).map((block) => block.Observe.message);
}

// The block names in chain order. A generated name says what the block is
// testing, so this is how a timeout block is told apart from an announcement
// that simply has nothing to say back to.
function blockNames(item: Record<string, any>): string[] {
  return walk(item).names;
}

function endsAtQueue(item: Record<string, any>): boolean {
  return walk(item).reachesQueue;
}

describe('literalPromptText', () => {
  it('strips SSML markup', () => {
    expect(literalPromptText('<speak>Welcome to <break time="300ms"/>the test flow</speak>')).toBe(
      'Welcome to the test flow'
    );
  });

  it('keeps the longest literal run around a dynamic attribute', () => {
    expect(
      literalPromptText('Hello $.Attributes.FirstName, welcome to the technical help menu options.')
    ).toBe(', welcome to the technical help menu options.');
  });

  it('reads a prompt laid out over several lines as one line', () => {
    expect(literalPromptText('Press one for sales.\nPress two for support.')).toBe(
      'Press one for sales. Press two for support.'
    );
  });

  it('ignores non-text prompts', () => {
    expect(literalPromptText(undefined)).toBeUndefined();
    expect(literalPromptText('$.Attributes.Prompt')).toBeUndefined();
  });

  it('puts back an attribute whose value is known', () => {
    // A prompt that is nothing but the reference has no literal run of its own,
    // so this is the difference between asserting the announcement and dropping
    // the block entirely.
    const known = new Map([['ooo_message', 'We are closed until Monday.']]);
    expect(literalPromptText('$.Attributes.ooo_message', known)).toBe('We are closed until Monday.');
    expect(literalPromptText("$.Attributes['ooo_message']", known)).toBe(
      'We are closed until Monday.'
    );
  });

  it('leaves an attribute nothing set to the longest literal run', () => {
    const known = new Map([['ooo_message', 'We are closed until Monday.']]);
    expect(literalPromptText('Hello $.Attributes.FirstName, we are closed today.', known)).toBe(
      ', we are closed today.'
    );
  });
});

describe('sanitizeLabel', () => {
  it('spells out the non-alphanumeric DTMF keys', () => {
    expect(sanitizeLabel('1.*')).toBe('1.star');
    expect(sanitizeLabel('1.#')).toBe('1.hash');
    expect(sanitizeLabel('1.2.3')).toBe('1.2.3');
  });
});

// Where the generated config lands. It has to sit directly under the prefix the
// loader watches, and it has to be the same key on the delete path as on the
// create path - otherwise deleting a flow definition would leave its test cases
// behind in Connect.
describe('the generated config key', () => {
  it('writes one config per flow, named after the flow, straight into test-case-data/', () => {
    expect(generatedKey('BM-Test-IaC-Flow')).toBe('test-case-data/BM-Test-IaC-Flow.json');
  });

  it('takes the flow name from the file name', () => {
    expect(flowNameFromKey('flow-definition/BM-Test-IaC-Flow.json')).toBe('BM-Test-IaC-Flow');
    expect(flowNameFromKey('flow-definition/Sales-Flow.json')).toBe('Sales-Flow');
  });

  it('maps a definition to its config and back to the same key', () => {
    // The whole teardown chain hangs off these three names lining up: the key
    // deleted, the config deleted with it, and the test cases named after the
    // flow. One flow, one definition, one config.
    const key = 'flow-definition/Sales-Flow.json';
    expect(generatedKey(flowNameFromKey(key))).toBe('test-case-data/Sales-Flow.json');
    expect(testCaseNamePrefix(flowNameFromKey(key))).toBe('Sales-Flow:');
  });

  it('refuses a definition in a subfolder, whose file name is not the flow name', () => {
    // The old layout. It has to fail rather than silently generate a config for a
    // flow called "flow", which would never match a contact flow in Connect.
    expect(() => flowNameFromKey('flow-definition/BM-Test-IaC-Flow/flow.json')).toThrow(
      /not a flow definition/
    );
    expect(() => flowNameFromKey('flow-definition/')).toThrow(/not a flow definition/);
  });

  it('refuses a folder placeholder that ends in the flow’s name', () => {
    // A console "folder" is a zero-byte object whose key ends in "/", which leaves
    // exactly one segment - the flow's name. Reading that as the flow itself would
    // mean deleting a leftover "flow-definition/BM-Test-IaC-Flow/" from the old
    // layout tore down the live flow's test cases. Requiring the ".json" is what
    // tells the two apart.
    expect(() => flowNameFromKey('flow-definition/BM-Test-IaC-Flow/')).toThrow(
      /not a flow definition/
    );
    expect(() => flowNameFromKey('flow-definition/BM-Test-IaC-Flow')).toThrow(
      /not a flow definition/
    );
    expect(flowNameFromKey('flow-definition/BM-Test-IaC-Flow.JSON')).toBe('BM-Test-IaC-Flow');
  });

  it('does not let one flow’s name prefix another’s test cases', () => {
    // "BM-Test:" cannot match "BM-Test-IaC-Flow:1.1", so deleting the shorter
    // flow's definition cannot take the longer flow's test cases with it.
    expect('BM-Test-IaC-Flow:1.1'.startsWith(testCaseNamePrefix('BM-Test'))).toBe(false);
    expect('BM-Test-IaC-Flow:1.1'.startsWith(testCaseNamePrefix('BM-Test-IaC-Flow'))).toBe(true);
  });
});

// The definition that is actually deployed: nothing but the Amazon Connect
// export of BM-Test-IaC-Flow. Every queue and the hours of operation are read
// out of the flow's own blocks, the flow name is the folder it sits in, and the
// caller number comes from cdk.json - so this is the test that would fail if
// any of that stopped working.
describe('the BM-Test-IaC-Flow export', () => {
  const bundle = deployedBundle();

  // flowName is the folder name, as the generator derives it from the S3 key,
  // and the caller number arrives from DEFAULT_CALLER_NUMBER.
  const report: string[] = [];
  const items = generateTestCases(bundle, {
    flowName: 'BM-Test-IaC-Flow',
    defaults: { caller_number: '+1234567890' },
    warn: (m) => report.push(m),
  });

  // The consent prompt inside the rsa-popiaAct module the flow invokes. It is
  // only asserted because the module travels with the flow, so it doubles as the
  // check that the bundle's module is being walked at all.
  const popia = expect.stringContaining('Protection of Personal Information Act');

  // The hold message in "Default customer queue". Connect runs the customer queue
  // flow on the way into the queue, so this is the last thing heard on any path
  // that queues - after the flow's own prompts, before the transfer.
  const holdMessage =
    'Thank you for calling. Your call is very important to us and will be answered in the order it was received.';

  // The sales branch sets a different queue flow, whose hold message is built from
  // what the Lambda answered rather than written out - so the declared answer is
  // what it is spelt with, whatever the deployed file happens to say.
  const salesHoldMessage = `Thank you for calling. One of our ${declaredValues.agentWording} will be with you shortly.`;

  // The queue option 2's branches set, read off their own Set working queue blocks.
  const SALES_QUEUE_ID = '6b1b6ba4-22cb-4ace-a1ec-77cbde8fd152';

  it('is nothing but the flow and the flows it hands the caller to', () => {
    // The whole point: no queue, no hours, no flow name, no caller number is
    // written by hand. Everything routing-related is read out of the export -
    // and the modules and queue flows beside it are exports too, fetched rather
    // than authored. The two hand-written lines are the ones no export carries:
    // which flow Connect falls back to on hold, and what the Lambda answers.
    expect(Object.keys(bundle)).toEqual([
      'flow',
      'modules',
      'flows',
      'defaults',
      'external',
      'utterances',
    ]);
    expect(Object.keys(bundle.modules)).toEqual(['rsa-popiaAct']);
    expect(Object.keys(bundle.flows)).toEqual([
      'Default customer queue',
      'rsa-default-cust-queue',
      'BM-Test-Voice-IaC-Flow',
    ]);
    expect(bundle.defaults).toEqual({ customer_queue_flow: 'Default customer queue' });
    // Every value the flow's Lambda answers with, and nothing else: the six the
    // deployed sidecar declares, each already flattened to one answer above.
    expect(bundle.external).toEqual(declaredValues);
    expect(Object.keys(bundle.external).sort()).toEqual([
      'agentWording',
      'dicommisioned',
      'inHourEmergencyMessage',
      'isInHoursEmergency',
      'isOutOfHoursEmergency',
      'outOfHourEmergencyMessage',
    ]);
  });

  it('says which branch one answer per flag leaves untaken', () => {
    // What the rest of this suite is doing: pinned to one answer per key, each
    // check-attributes block only ever goes one way. Nothing in the generated test
    // cases shows that - they are named for the paths that exist - so the report is
    // the only place the gap is visible, and it is asserted here for the flow it is
    // about, which is also what the fan-out below has to close.
    const warnings: string[] = [];
    generateTestCases(deployedBundle(), {
      flowName: 'BM-Test-IaC-Flow',
      defaults: DEFAULTS,
      coverBranchValues: false,
      warn: (m) => warnings.push(m),
    });

    const report = warnings.filter(isBranchCoverageWarning);
    expect(report.map((message) => message.match(/branches on (\S+)/)![1])).toEqual([
      '$.Attributes.dicommisioned',
      '$.Attributes.isInHoursEmergency',
      // The reference number the asynchronous invocation answers with. The sidecar
      // says nothing about it, so with the fan-out off there is nothing to pin the
      // Compare block after the load block to, and it is reported like the flags.
      '$.External.auth_number',
      '$.Attributes.isOutOfHoursEmergency',
    ]);
    // The emergency block has three destinations, the reference number four, the
    // other two blocks two each: their "no matching condition" transitions point
    // where their "true" condition points, which is one branch to cover rather
    // than two.
    expect(report.map((message) => message.match(/of its (\d+) branches/)![1])).toEqual([
      '2',
      '3',
      '4',
      '2',
    ]);
    expect(report[1]).toContain('"Equals true", "no matching condition"');
  });

  it('covers every branch of every check-attributes block without being told the values', () => {
    // The declaration a person actually writes: one answer per key, and a key the flow
    // branches on left out altogether. Every branch is still covered, because the values
    // that matter are the ones the check-attributes blocks compare against and those are
    // read off the blocks. The report going quiet is the assertion that none were missed.
    const { isOutOfHoursEmergency, ...oneAnswerEach } = declaredValues;
    const warnings: string[] = [];
    const covered = generateTestCases(deployedBundle(), {
      flowName: 'BM-Test-IaC-Flow',
      defaults: DEFAULTS,
      externalValues: oneAnswerEach,
      coverBranchValues: true,
      warn: (m) => warnings.push(m),
    });

    // No branch is left out - that report going quiet is the assertion. What is left is
    // three things about the flow itself, each with a test of its own below: the answer
    // sets outgrowing the cap, the failure branch that only passes while the function is
    // down, and the two branches that set a queue and then end without transferring.
    expect(warnings.filter(isBranchCoverageWarning)).toEqual([]);
    expect([...new Set(warnings)]).toHaveLength(4);
    expect(warnings.join(' ')).toContain('more than the 32 allowed');
    expect(warnings.join(' ')).toContain('nothing on the branch transfers the contact');
    // What covering every branch costs in executions, including the flow this one
    // transfers to on the decommissioned branch and its voice menu.
    expect(Object.keys(covered)).toHaveLength(71);
    // The decommissioned branch no longer hangs up: it says so and transfers to
    // BM-Test-Voice-IaC-Flow, so the first thing its test cases assert is the
    // announcement and the last is that flow's own menu.
    const decommissioned = Object.keys(covered).filter((label) =>
      label.includes('dicommisioned-true')
    );
    expect(decommissioned.length).toBeGreaterThan(0);
    for (const label of decommissioned) {
      expect((covered[label] as any).welcome_message.Observe.message).toBe(
        'We are now transferring you to the voice test flow.'
      );
    }
    // Every side of every flag, and one for the answer the function does not give -
    // including the key that was left out of the declaration entirely, which the flow
    // branches on and so gets covered regardless.
    const labels = Object.keys(covered);
    expect(labels.some((label) => label.includes('isInHoursEmergency-true'))).toBe(true);
    expect(labels.some((label) => label.includes('isInHoursEmergency-unset'))).toBe(true);
    expect(labels.some((label) => label.includes('isOutOfHoursEmergency-true'))).toBe(true);
    expect(labels.some((label) => label.includes('isOutOfHoursEmergency-false'))).toBe(true);
    // Covered, but not seeded: nothing answers the invocation for it. Each of these
    // test cases asserts the branch its value takes, and the one the real function
    // answers for is the one that passes.
    const outOfHours = labels.find((label) => label.includes('isOutOfHoursEmergency-true'))!;
    expect((covered[outOfHours] as any).lambda_mocks).toBeUndefined();
  });

  it('asserts the hold message of the queue flow a queued branch runs', () => {
    // A branch that transfers sets no customer queue flow of its own, so Connect
    // runs "Default customer queue" and the hold message comes out of that flow
    // rather than out of this one.
    const queued = Object.values(items).filter((item) => endsAtQueue(item));
    expect(queued.length).toBeGreaterThan(0);
    for (const item of queued) {
      // Last thing heard, and heard after the transfer: Connect starts the transfer
      // first and the queue flow plays this once the contact is on its way in, so
      // the hold message is what ends the test.
      expect(blockNames(item).at(-1)).toBe('queue_message_1');
      expect((item as any).check_queue).toEqual({ next: 'queue_message_1' });
      expect((item as any).queue_message_1.Observe.message).toBe(holdMessage);
    }

    // And nowhere else: a path that never transfers hears no hold message, whether
    // it hung up or - as the sales branch does - set a queue and then ended.
    for (const item of Object.values(items).filter((item) => !endsAtQueue(item))) {
      expect((item as any).queue_message_1).toBeUndefined();
      expect((item as any).check_queue).toBeUndefined();
    }
  });

  it('reports the sales branch setting a queue it never transfers to', () => {
    // A flow bug this suite is pinning rather than papering over: option 2's branches
    // set the sales queue and name "rsa-default-cust-queue" as the flow to hold the
    // caller with, then run into an End flow block without a "Transfer to queue" in
    // between. So the queue is on the test case, nothing is queued, and the sales
    // hold message is never heard by anything.
    // Not one of option 2's test cases queues, however far down it gets - and none of
    // them carries a queue either, because the queue on a test case is the one the
    // contact is transferred to and nothing here transfers.
    const sales = Object.keys(items).filter((label) => label.startsWith('2'));
    expect(sales.length).toBeGreaterThan(0);
    for (const label of sales) {
      expect(items[label].queue).toBeUndefined();
      expect(endsAtQueue(items[label])).toBe(false);
    }
    // So the hold message written into "rsa-default-cust-queue" is never heard by
    // anything, which is the visible cost of the missing block.
    expect(
      Object.values(items).map((item) => (item as any).queue_message_1?.Observe?.message)
    ).not.toContain(salesHoldMessage);
    // The only place the gap is visible, which is why it is asserted here - naming the
    // queue the branch set and the block that set it.
    expect(report.join(' ')).toContain(
      `ends the flow on a branch that set the working queue (${SALES_QUEUE_ID})`
    );
    expect(report.join(' ')).toContain(
      'named a customer queue flow, but nothing on the branch transfers the contact'
    );
  });

  it('covers every menu level reachable from the main menu', () => {
    // Option 2 is three levels deep: the sales menu, then the reference number the
    // caller types, then confirming it - and each of those levels has its own
    // Timeout and Default exits, which is where the bulk of these come from.
    expect(Object.keys(items).sort()).toEqual([
      '1.1',
      '1.2',
      '1.Default',
      '1.Timeout',
      '1.hash',
      '1.star',
      '2.1',
      '2.1.rsa-get-cust-ref-cdk-error',
      '2.2',
      '2.Default',
      '2.Default.1',
      '2.Default.1.rsa-get-cust-ref-cdk-error',
      '2.Default.2',
      '2.Default.Default',
      '2.Default.Timeout',
      '2.Timeout',
      '2.Timeout.1',
      '2.Timeout.1.rsa-get-cust-ref-cdk-error',
      '2.Timeout.2',
      '2.Timeout.Default',
      '2.Timeout.Timeout',
      '3',
      'Default',
      'OutOfHour',
      'Timeout',
      'star',
    ]);
  });

  it('gives each branch the queue its own Set working queue block names', () => {
    // Four menu options, four different queues. A single configured default
    // would have asserted the same queue for all of them.
    expect({
      '1.1': items['1.1'].queue,
      '1.2': items['1.2'].queue,
      '3': items['3'].queue,
      Timeout: items['Timeout'].queue,
    }).toEqual({
      '1.1': '73e9d156-a62d-4471-9cbb-af126df78a1d',
      '1.2': '14b354a2-c688-4e1f-9ba6-e90089a615cc',
      '3': 'a3ddb3e2-2b7d-4561-9336-749cfa14f910',
      Timeout: 'a3ddb3e2-2b7d-4561-9336-749cfa14f910',
    });

    // Option 2 is missing from that list because it never transfers - the subject of
    // its own test above.
    for (const label of ['1.1', '1.2', '3', 'Timeout']) {
      expect(endsAtQueue(items[label])).toBe(true);
    }
  });

  it('prefers the queue id in the parameters over the name in the metadata', () => {
    // Both technical options are labelled "BM-Test-Technical-Wifi-IaC" in the
    // designer metadata, but option 2 routes to a different queue id. The
    // parameter is the truth.
    expect(items['1.2'].queue).not.toBe(items['1.1'].queue);
  });

  it('takes the hours of operation off the CheckHoursOfOperation block', () => {
    for (const item of Object.values(items)) {
      expect(item.hours_of_operation).toBe('4605e369-8882-44d8-a3e9-069bb7fb7120');
      expect(item.caller_number).toBe('+1234567890');
    }
  });

  it('generates the flow’s own out-of-hours announcement as its own test case', () => {
    // The closed branch says nothing but "$.Attributes.ooo_message", which a Set
    // contact attributes block just before it fills in. Read literally there is no
    // text to assert at all, so this whole test case only exists because the value
    // is followed to the prompt that plays it.
    const closed = items['OutOfHour'];
    expect(closed.hours_of_operation_results).toBe('OutOfHour');
    expect(messages(closed)).toEqual([
      'Good day, this office if currently out of hours please call again during office hours from 9 AM to 5 PM. Thank you.',
    ]);
    expect(closed.queue).toBeUndefined();
    expect(endsAtQueue(closed)).toBe(false);
  });

  it('mocks the check as open for every menu path', () => {
    for (const [label, item] of Object.entries(items)) {
      if (label === 'OutOfHour') continue;
      expect(item.hours_of_operation_results).toBe('InHour');
    }
  });

  it('labels each test case by the digits pressed to reach it', () => {
    for (const [label, item] of Object.entries(items)) {
      expect(item['testing-option']).toBe(label);
      expect(item['flow-name']).toBe('BM-Test-IaC-Flow');
    }
  });

  it('builds a chain of the prompts heard and the digits sent', () => {
    const item = items['1.1'];
    expect(messages(item)).toEqual([
      'Welcome to the test flow.',
      'Please note that this call may be recorded or monitored for quality assurance and training purposes.',
      popia,
      expect.stringContaining('Please press one for technical issues.'),
      expect.stringContaining('Welcome to the technical help menu options.'),
      holdMessage,
    ]);

    expect(chain(item).map((block) => block.Action?.user_action)).toEqual([
      undefined,
      undefined,
      undefined,
      '1',
      '1',
      undefined,
    ]);
    expect(chain(item)[3].Action).toEqual({ type: 'DtmfInput', user_action: '1' });
  });

  it('turns a repeat option into a replay assertion with no queue', () => {
    // "*" on the technical menu goes back to the main menu, "#" replays the
    // technical menu. Neither reaches a queue, so neither asserts one.
    expect(messages(items['1.star']).pop()).toContain('Please press one for technical issues.');
    expect(messages(items['1.hash']).pop()).toContain('Welcome to the technical help menu options.');
    for (const label of ['1.star', '1.hash', 'star']) {
      expect(items[label].queue).toBeUndefined();
      expect(endsAtQueue(items[label])).toBe(false);
    }
  });

  // The main menu's timeout and no-match branches both land on a Loop block with
  // LoopCount 2, which replays the menu twice before giving up. A test case that
  // stopped at the first prompt would pass without ever reaching the loop's
  // DoneLooping side, so every block of every iteration has to be asserted.
  it('replays a menu once per loop iteration, then follows DoneLooping to the end', () => {
    const retry = 'You have not selected any option. Please try again.';
    const giveUp =
      'You have not selected a correct option, please wait while we tranfer you to an agent. Thank you';

    expect(messages(items['Timeout'])).toEqual([
      'Welcome to the test flow.',
      expect.stringContaining('this call may be recorded'),
      popia,
      expect.stringContaining('Please press one for technical issues.'),
      retry,
      expect.stringContaining('Please press one for technical issues.'),
      retry,
      expect.stringContaining('Please press one for technical issues.'),
      giveUp,
      holdMessage,
    ]);

    // LoopCount 2 means two ContinueLooping passes and then DoneLooping, so the
    // prompt is heard three times and the retry announcement twice.
    expect(messages(items['Timeout']).filter((m) => m === retry)).toHaveLength(2);
    expect(endsAtQueue(items['Timeout'])).toBe(true);
    expect(items['Timeout'].queue).toBe('a3ddb3e2-2b7d-4561-9336-749cfa14f910');
  });

  it('withholds input at every prompt of a timeout loop', () => {
    // Sending anything at any pass would leave the timeout branch, so none of
    // the menu blocks on this path may carry an Action.
    for (const block of chain(items['Timeout'])) {
      expect(block.Action).toBeUndefined();
    }
    expect(blockNames(items['Timeout'])).toEqual([
      'welcome_message',
      'prompt_2',
      'prompt_3',
      'timeout_4',
      'prompt_5',
      'timeout_6',
      'prompt_7',
      'timeout_8',
      'prompt_9',
      'queue_message_1',
    ]);
  });

  it('presses the unoffered digit at every prompt of a no-match loop', () => {
    // Same shape as the timeout, but each pass has to actively fail to match.
    // The main menu offers 1, 2, 3 and *, so 9 is the input that no-matches.
    const unmatched = chain(items['Default']).filter((block) => block.Action);
    expect(unmatched).toHaveLength(3);
    for (const block of unmatched) {
      expect(block.Action).toEqual({ type: 'DtmfInput', user_action: '9' });
    }
    expect(blockNames(items['Default'])).toEqual([
      'welcome_message',
      'prompt_2',
      'prompt_3',
      'default_4',
      'prompt_5',
      'default_6',
      'prompt_7',
      'default_8',
      'prompt_9',
      'queue_message_1',
    ]);
    expect(items['Default'].queue).toBe('a3ddb3e2-2b7d-4561-9336-749cfa14f910');
  });

  it('walks a submenu’s own loop after the digits that reach it', () => {
    // The technical menu has its own Loop with its own retry announcement, so
    // leaving it by timeout replays the technical prompt rather than the main
    // menu's, and only rejoins the shared give-up path once that loop is spent.
    // Its LoopCount is 3 against the main menu's 2, so it is heard four times.
    const techMenu = expect.stringContaining('Welcome to the technical help menu options.');
    const techRetry = 'You have not selected an option, please try again.';

    expect(messages(items['1.Timeout'])).toEqual([
      'Welcome to the test flow.',
      expect.stringContaining('this call may be recorded'),
      popia,
      expect.stringContaining('Please press one for technical issues.'),
      techMenu,
      techRetry,
      techMenu,
      techRetry,
      techMenu,
      techRetry,
      techMenu,
      expect.stringContaining('please wait while we tranfer you to an agent'),
      holdMessage,
    ]);
    expect(messages(items['1.Timeout']).filter((m) => m === techRetry)).toHaveLength(3);
    // The digit that reached the submenu is still sent, only the submenu is
    // left without choosing.
    expect(chain(items['1.Timeout'])[3].Action).toEqual({ type: 'DtmfInput', user_action: '1' });
    expect(endsAtQueue(items['1.Timeout'])).toBe(true);
  });

  it('terminates a loop rather than walking it forever', () => {
    // Nothing about a Loop block stops a walk on its own: ContinueLooping goes
    // back to where the path came from. A missed iteration count would hang the
    // generator or blow the test case cap, so both are asserted.
    const warnings: string[] = [];
    const generated = generateTestCases(bundle, {
      flowName: 'BM-Test-IaC-Flow',
      warn: (m) => warnings.push(m),
    });
    expect(Object.keys(generated)).toHaveLength(26);
    // The three the flow itself earns - the failure branch, the branch that sets a
    // queue without transferring, and the reference number nothing declares - are
    // each asserted where they belong; a fourth would be a regression.
    expect([...new Set(otherWarnings(warnings))]).toHaveLength(3);
    for (const item of Object.values(generated)) {
      // chain() itself throws on a repeated block, so this is the assertion
      // that every generated path is finite and acyclic.
      expect(chain(item).length).toBeLessThan(20);
    }
  });

  it('respects the max menu depth', () => {
    const shallow = generateTestCases(bundle, {
      flowName: 'BM-Test-IaC-Flow',
      maxMenuDepth: 1,
      warn: () => {},
    });
    // The depth limit only truncates the digit branches. A timeout or a no-match
    // is not a level deeper - it is the same menu, left the other way - so the
    // main menu's two exits survive a limit of one.
    expect(Object.keys(shallow).sort()).toEqual([
      '1',
      '2',
      // The sales menu's own timeout and no-match, which are not a level deeper.
      '2.Default',
      '2.Timeout',
      '3',
      'Default',
      'OutOfHour',
      'Timeout',
      'star',
    ]);
  });

  it('respects the test case cap', () => {
    const capped = generateTestCases(bundle, {
      flowName: 'BM-Test-IaC-Flow',
      maxTestCases: 2,
      warn: () => {},
    });
    expect(Object.keys(capped)).toHaveLength(2);
  });
});

// The voice sibling of the flow above: the same shape of menu tree, answered by
// speaking to a Lex bot rather than by pressing digits. Everything that made the
// DTMF flow work has to work here too - one test case per branch, the queue off
// each branch's own block, the retry loop walked to its end - with the one
// difference that a Lex block branches on intent names, so what the caller says
// to reach each branch comes off the bot instead of out of the flow.
describe('the BM-Test-Voice-IaC-Flow export', () => {
  const bundle = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', 'flow-definition', 'BM-Test-Voice-IaC-Flow.json'),
      'utf-8'
    )
  );

  const BOT_ALIAS = 'arn:aws:lex:af-south-1:687244881512:bot-alias/HMMAXX5G6E/TSTALIASID';

  // What DescribeIntent would return for each intent the flow branches on.
  const SAMPLE_UTTERANCES: Record<string, string> = {
    'bs-general': 'I have a general query',
    'bs-technical': 'I have a technical problem',
    'bs-sales': 'I would like to buy something',
    'bs-technical-wifi': 'my wifi is not working',
    'bs-technical-laptop': 'my laptop is broken',
  };

  const NO_MATCH = 'something completely unrelated to any of these options';

  function fakeLex(calls: string[] = []): LexLookups {
    return {
      async sampleUtterance(aliasArn, intentName) {
        calls.push(`DescribeIntent(${aliasArn}, ${intentName})`);
        return SAMPLE_UTTERANCES[intentName];
      },
    };
  }

  const utterances: Utterances = new Map(
    Object.entries(SAMPLE_UTTERANCES).map(([intent, utterance]) => [
      utteranceKey(BOT_ALIAS, intent),
      utterance,
    ])
  );

  const items = generateTestCases(bundle, {
    flowName: 'BM-Test-Voice-IaC-Flow',
    defaults: { caller_number: '+1234567890' },
    utterances,
    warn: () => {},
  });

  it('is nothing but the flow', () => {
    // A bare export, with no wrapper and nothing hand-written alongside it: the
    // queues, the hours and the bot all come out of its own blocks.
    expect(Object.keys(bundle).sort()).toEqual(['Actions', 'Metadata', 'StartAction', 'Version']);
  });

  it('finds every intent the flow branches on, and the bot behind them', () => {
    expect(lexBotReferences(bundle)).toEqual([
      {
        aliasArn: BOT_ALIAS,
        intents: expect.arrayContaining(Object.keys(SAMPLE_UTTERANCES)),
      },
    ]);
    expect(lexBotReferences(bundle)[0].intents).toHaveLength(5);
  });

  it('covers every intent branch, on both voice menus', () => {
    expect(Object.keys(items).sort()).toEqual([
      'Default',
      'OutOfHour',
      'Timeout',
      'bs-general',
      'bs-sales',
      'bs-technical.Default',
      'bs-technical.Timeout',
      'bs-technical.bs-technical-laptop',
      'bs-technical.bs-technical-wifi',
    ]);
  });

  it('labels each test case by the intents matched to reach it', () => {
    for (const [label, item] of Object.entries(items)) {
      expect(item['testing-option']).toBe(label);
      expect(item['flow-name']).toBe('BM-Test-Voice-IaC-Flow');
    }
  });

  it('says what the bot understands, not the intent name', () => {
    // The intent name is what the flow branches on, so it is what names the test
    // case - but saying it out loud would land on the no-match branch instead.
    const wifi = chain(items['bs-technical.bs-technical-wifi']);
    expect(wifi.map((block) => block.Action)).toEqual([
      undefined,
      { type: 'Utterance', user_action: 'I have a technical problem' },
      { type: 'Utterance', user_action: 'my wifi is not working' },
    ]);
    expect(messages(items['bs-technical.bs-technical-wifi'])).toEqual([
      'Welcome to the voice test flow',
      expect.stringContaining('Please let us know the purpose of your call.'),
      expect.stringContaining('Welcome to the technical menu.'),
    ]);
  });

  it('gives each branch the queue its own Set working queue block names', () => {
    expect({
      'bs-general': items['bs-general'].queue,
      'bs-sales': items['bs-sales'].queue,
      'bs-technical.bs-technical-wifi': items['bs-technical.bs-technical-wifi'].queue,
      'bs-technical.bs-technical-laptop': items['bs-technical.bs-technical-laptop'].queue,
    }).toEqual({
      'bs-general': 'a3ddb3e2-2b7d-4561-9336-749cfa14f910',
      'bs-sales': '6b1b6ba4-22cb-4ace-a1ec-77cbde8fd152',
      'bs-technical.bs-technical-wifi': '73e9d156-a62d-4471-9cbb-af126df78a1d',
      'bs-technical.bs-technical-laptop': '14b354a2-c688-4e1f-9ba6-e90089a615cc',
    });

    for (const label of [
      'bs-general',
      'bs-sales',
      'bs-technical.bs-technical-wifi',
      'bs-technical.bs-technical-laptop',
    ]) {
      expect(endsAtQueue(items[label])).toBe(true);
    }
  });

  it('takes the hours of operation off the CheckHoursOfOperation block', () => {
    for (const item of Object.values(items)) {
      expect(item.hours_of_operation).toBe('4605e369-8882-44d8-a3e9-069bb7fb7120');
      expect(item.caller_number).toBe('+1234567890');
    }
  });

  it('generates the flow’s own out-of-hours announcement as its own test case', () => {
    const closed = items['OutOfHour'];
    expect(closed.hours_of_operation_results).toBe('OutOfHour');
    expect(messages(closed)).toEqual([expect.stringContaining('out of hours')]);
    expect(endsAtQueue(closed)).toBe(false);
  });

  // The same retry loop the DTMF flow has, driven by speech: the bot fails to
  // understand twice, the flow re-prompts, and only on the third failure does it
  // give up and transfer. LoopCount is 2, so the menu prompt is heard three times.
  it('replays a voice menu once per loop iteration, then follows DoneLooping to the end', () => {
    const retry = "I didn't quite get that, please try again";
    const giveUp = 'I transfer you to an agent';

    expect(messages(items['Default'])).toEqual([
      'Welcome to the voice test flow',
      expect.stringContaining('Please let us know the purpose of your call.'),
      retry,
      expect.stringContaining('Please let us know the purpose of your call.'),
      retry,
      expect.stringContaining('Please let us know the purpose of your call.'),
      expect.stringContaining(giveUp),
    ]);

    // Every pass has to actively fail to match, or the path leaves the no-match
    // branch and the rest of the loop is never reached.
    const spoken = chain(items['Default']).filter((block) => block.Action);
    expect(spoken).toHaveLength(3);
    for (const block of spoken) {
      expect(block.Action).toEqual({ type: 'Utterance', user_action: NO_MATCH });
    }
    expect(endsAtQueue(items['Default'])).toBe(true);
    expect(items['Default'].queue).toBe('a3ddb3e2-2b7d-4561-9336-749cfa14f910');
  });

  it('says nothing at every prompt of a silence loop', () => {
    // A Lex block declares no timeout branch of its own: saying nothing leaves
    // the bot with no intent, which is the same no-match branch. So the route is
    // the Default one, walked without ever answering.
    for (const block of chain(items['Timeout'])) {
      expect(block.Action).toBeUndefined();
    }
    expect(blockNames(items['Timeout'])).toEqual([
      'welcome_message',
      'timeout_2',
      'prompt_3',
      'timeout_4',
      'prompt_5',
      'timeout_6',
      'prompt_7',
    ]);
    expect(items['Timeout'].queue).toBe('a3ddb3e2-2b7d-4561-9336-749cfa14f910');
  });

  it('never mistakes a Lex block’s error branch for its no-match branch', () => {
    // The block's default transition is "Something went wrong, please call
    // again." - what the flow does when the bot itself fails, which no caller
    // behaviour reaches. A test case asserting it would be about nothing.
    for (const item of Object.values(items)) {
      expect(messages(item).join('\n')).not.toContain('Something went wrong');
    }
  });

  it('walks the submenu’s no-match loop out through the main menu, as the flow does', () => {
    // The technical menu's retry lands on the shared loop, whose ContinueLooping
    // re-prompts and returns to the *main* menu rather than the technical one. So the
    // caller says the same thing again, is asked the same thing again and no-matches
    // again, once per pass - and the pass the loop has no more of is the one that
    // gives up and transfers them, which is the whole point of the loop and is not
    // reached at all by a test case that stops at the first pass.
    const mainMenu = expect.stringContaining('Please let us know the purpose of your call.');
    const techMenu = expect.stringContaining('Welcome to the technical menu.');
    const retry = "I didn't quite get that, please try again";

    expect(messages(items['bs-technical.Default'])).toEqual([
      'Welcome to the voice test flow',
      mainMenu,
      techMenu,
      retry,
      mainMenu,
      techMenu,
      retry,
      mainMenu,
      techMenu,
      "I didn't quite get that, please hold whil;e I transfer you to an agent.",
    ]);

    // Every pass is the same caller doing the same thing: the utterance that reached
    // the submenu is said again, and the submenu is answered again with something the
    // bot cannot match.
    const answered = chain(items['bs-technical.Default']).filter((block) => block.Action);
    expect(answered.map((block) => block.Action?.user_action)).toEqual([
      'I have a technical problem',
      NO_MATCH,
      'I have a technical problem',
      NO_MATCH,
      'I have a technical problem',
      NO_MATCH,
    ]);

    // The give-up branch transfers, so the path now ends where the flow ends it.
    expect(endsAtQueue(items['bs-technical.Default'])).toBe(true);
    expect(items['bs-technical.Default'].queue).toBe('a3ddb3e2-2b7d-4561-9336-749cfa14f910');
  });

  it('terminates every path rather than walking the retry loop forever', () => {
    const warnings: string[] = [];
    const generated = generateTestCases(bundle, {
      flowName: 'BM-Test-Voice-IaC-Flow',
      utterances,
      warn: (m) => warnings.push(m),
    });
    expect(Object.keys(generated)).toHaveLength(9);
    // The only thing left to say about this definition: generated without touching
    // AWS, so nothing could be read about what a caller waiting in a queue hears -
    // this export sets no CustomerQueue event hook, and the instance default it
    // really falls back to can only be read off the instance.
    expect(warnings).toEqual([
      expect.stringContaining('reaches a queue but nothing could be read'),
    ]);
    for (const item of Object.values(generated)) {
      expect(chain(item).length).toBeLessThan(20);
    }
  });

  it('reads the utterances off the bot the block names', async () => {
    const calls: string[] = [];
    const generated = await generateTestCasesWithConnect(
      bundle,
      { flowName: 'BM-Test-Voice-IaC-Flow', warn: () => {} },
      {
        async queueIdForName() {
          return undefined;
        },
        async hoursOfOperationIdForName() {
          return undefined;
        },
        async hoursOfOperationIdForQueue() {
          return undefined;
        },
        async customerQueueFlowIdForName() {
          return undefined;
        },
        async contactFlowDefinition() {
          return undefined;
        },
        async contactFlowModuleDefinition() {
          return undefined;
        },
      },
      fakeLex(calls)
    );

    expect(Object.keys(generated).sort()).toEqual(Object.keys(items).sort());
    expect(calls).toContain(`DescribeIntent(${BOT_ALIAS}, bs-sales)`);
    expect(chain(generated['bs-sales'])[1].Action).toEqual({
      type: 'Utterance',
      user_action: 'I would like to buy something',
    });
  });

  it('skips an intent branch nothing says how to reach, rather than guessing', () => {
    // Saying "bs-sales" out loud would not match the bs-sales intent, so the
    // test case would fail for a reason that is not about the flow. The intent
    // branches drop out; the ways of failing to be understood still work, since
    // those need no utterance from the bot.
    const warnings: string[] = [];
    const blind = generateTestCases(bundle, {
      flowName: 'BM-Test-Voice-IaC-Flow',
      warn: (m) => warnings.push(m),
    });
    expect(Object.keys(blind).sort()).toEqual(['Default', 'OutOfHour', 'Timeout']);
    expect(warnings.join('\n')).toContain('branches on intent "bs-sales"');
    expect(warnings.join('\n')).toContain('"utterances"');
  });

  it('lets the definition spell out what to say for an intent', () => {
    // Which outranks the bot's own sample utterances: the author is naming the
    // exact phrase to test with.
    const spelled = generateTestCases(
      { ...bundle, utterances: { 'bs-sales': 'put me through to sales please' } },
      { flowName: 'BM-Test-Voice-IaC-Flow', utterances, warn: () => {} }
    );
    expect(chain(spelled['bs-sales'])[1].Action).toEqual({
      type: 'Utterance',
      user_action: 'put me through to sales please',
    });
    // The intents it says nothing about still come off the bot.
    expect(chain(spelled['bs-general'])[1].Action?.user_action).toBe('I have a general query');
  });

  it('lets the definition change what the no-match branch says', () => {
    const custom = generateTestCases(
      { ...bundle, defaults: { no_match_utterance: 'wibble wobble' } },
      { flowName: 'BM-Test-Voice-IaC-Flow', utterances, warn: () => {} }
    );
    expect(chain(custom['Default'])[1].Action).toEqual({
      type: 'Utterance',
      user_action: 'wibble wobble',
    });
  });
});

describe('speakableUtterance', () => {
  it('prefers a sample utterance a caller could actually say', () => {
    expect(speakableUtterance(['book a {RoomType} room', 'I need a room'])).toBe('I need a room');
  });

  it('drops the slot placeholders when every sample has one', () => {
    expect(speakableUtterance(['book a {RoomType} room for {Nights} nights'])).toBe(
      'book a room for nights'
    );
  });

  it('has nothing to say for an intent with no samples', () => {
    expect(speakableUtterance([])).toBeUndefined();
    expect(speakableUtterance([undefined, '   '])).toBeUndefined();
  });
});

describe('menu tree definitions', () => {
  // The hand-authored shorthand, for stubbing a flow that has no export yet.
  // It has no CheckHoursOfOperation block to read, so this is the one format
  // where the hours have to be written into the definition.
  const bundle = {
    defaults: {
      caller_number: '+1234567890',
      hours_of_operation: '4605e369-8882-44d8-a3e9-069bb7fb7120',
    },
    prompts: [
      'Welcome to the test flow',
      'Please note that this call may be recorded or monitored for quality assurance and training purposes.',
    ],
    start: 'main_menu',
    out_of_hours: {
      prompts: ['Sorry, our offices are currently closed. Goodbye.'],
      disconnect: true,
    },
    menus: {
      main_menu: {
        prompt: 'Please press one for technical issues.\nPress two for Sales.',
        options: {
          '1': 'technical_menu',
          '2': 'queue:6b1b6ba4-22cb-4ace-a1ec-77cbde8fd152',
          '*': 'repeat',
        },
      },
      technical_menu: {
        prompt: 'Press one for WiFi issues, press two for laptop issues.',
        options: {
          '1': 'queue:73e9d156-a62d-4471-9cbb-af126df78a1d',
          '2': {
            prompts: ['Our office WiFi guide has been sent to you by email. Goodbye.'],
            disconnect: true,
          },
          '*': 'main_menu',
        },
      },
    },
  };

  const items = generateTestCases(bundle, { flowName: 'BM-Test-IaC-Flow', warn: () => {} });

  it('covers every menu level reachable from the main menu', () => {
    expect(Object.keys(items).sort()).toEqual(['1.1', '1.2', '1.star', '2', 'OutOfHour']);
  });

  it('carries the queue each option declares', () => {
    expect(items['1.1'].queue).toBe('73e9d156-a62d-4471-9cbb-af126df78a1d');
    expect(items['2'].queue).toBe('6b1b6ba4-22cb-4ace-a1ec-77cbde8fd152');
    expect(endsAtQueue(items['1.1'])).toBe(true);
  });

  it('ends a disconnect path on its last prompt, with no queue', () => {
    expect(endsAtQueue(items['1.2'])).toBe(false);
    expect(items['1.2'].queue).toBeUndefined();
    expect(messages(items['1.2']).pop()).toBe(
      'Our office WiFi guide has been sent to you by email. Goodbye.'
    );
  });

  it('generates the declared out-of-hours announcement as its own test case', () => {
    const closed = items['OutOfHour'];
    expect(closed.hours_of_operation_results).toBe('OutOfHour');
    expect(messages(closed).pop()).toContain('our offices are currently closed');
    expect(endsAtQueue(closed)).toBe(false);
  });

  it('turns a return-to-main-menu option into a replay assertion', () => {
    expect(messages(items['1.star']).pop()).toContain('Please press one for technical issues.');
    expect(endsAtQueue(items['1.star'])).toBe(false);
  });

  it('reads a prompt written over two lines as one line of text', () => {
    // The main menu's prompt is laid out over two lines, the way it reads in the
    // console. Connect matches the sentence, so the test case observes it whole.
    expect(messages(items['2'])).toContain('Please press one for technical issues. Press two for Sales.');
    for (const item of Object.values(items)) {
      for (const message of messages(item)) expect(message).not.toContain('\n');
    }
  });

  it('falls back to the hours written in the definition', () => {
    for (const item of Object.values(items)) {
      expect(item.hours_of_operation).toBe('4605e369-8882-44d8-a3e9-069bb7fb7120');
      expect(item.caller_number).toBe('+1234567890');
    }
  });
});

describe('Amazon Connect export bundles', () => {
  const arn = (type: string, id: string) =>
    `arn:aws:connect:eu-west-2:111122223333:instance/6e669f6f-3783-4c0e-ac76-4f531575015d/${type}/${id}`;

  const mainFlow = {
    Version: '2019-10-30',
    StartAction: 'set-voice',
    Metadata: {
      name: 'BM-Test-IaC-Flow',
      ActionMetadata: {
        'transfer-to-sales': { ContactFlowId: { text: 'Sales-Flow' } },
      },
    },
    Actions: [
      { Identifier: 'set-voice', Type: 'UpdateContactTextToSpeechVoice', Parameters: {}, Transitions: { NextAction: 'check-hoo' } },
      {
        Identifier: 'check-hoo',
        Type: 'CheckHoursOfOperation',
        Parameters: { HoursOfOperationId: arn('operating-hours', 'hoo-123') },
        Transitions: {
          NextAction: 'welcome',
          Conditions: [{ NextAction: 'closed', Condition: { Operator: 'Equals', Operands: ['False'] } }],
        },
      },
      {
        Identifier: 'welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome to the test flow' },
        Transitions: { NextAction: 'invoke-compliance' },
      },
      {
        Identifier: 'invoke-compliance',
        Type: 'InvokeFlowModule',
        Parameters: { FlowModuleId: arn('flow-module', 'compliance-module') },
        Transitions: { NextAction: 'main-menu' },
      },
      {
        Identifier: 'main-menu',
        Type: 'GetParticipantInput',
        Parameters: { Text: 'Press one for technical issues.\nPress two for Sales.' },
        Transitions: {
          NextAction: 'hangup',
          Conditions: [
            { NextAction: 'technical-menu', Condition: { Operator: 'Equals', Operands: ['1'] } },
            { NextAction: 'transfer-to-sales', Condition: { Operator: 'Equals', Operands: ['2'] } },
          ],
        },
      },
      {
        Identifier: 'technical-menu',
        Type: 'GetParticipantInput',
        Parameters: { Text: 'Press one for WiFi issues, press two for laptop issues.' },
        Transitions: {
          NextAction: 'hangup',
          Conditions: [
            { NextAction: 'set-tech-queue', Condition: { Operator: 'Equals', Operands: ['1'] } },
            { NextAction: 'hangup', Condition: { Operator: 'Equals', Operands: ['2'] } },
          ],
        },
      },
      {
        Identifier: 'set-tech-queue',
        Type: 'UpdateContactTargetQueue',
        Parameters: { QueueId: arn('queue', 'tech-queue') },
        Transitions: { NextAction: 'to-queue' },
      },
      { Identifier: 'to-queue', Type: 'TransferContactToQueue', Parameters: {}, Transitions: {} },
      {
        Identifier: 'transfer-to-sales',
        Type: 'TransferToFlow',
        Parameters: { ContactFlowId: arn('contact-flow', 'sales-flow-id') },
        Transitions: {},
      },
      { Identifier: 'closed', Type: 'MessageParticipant', Parameters: { Text: 'We are closed' }, Transitions: { NextAction: 'hangup' } },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  const complianceModule = {
    Version: '2019-10-30',
    StartAction: 'compliance-message',
    Metadata: { name: 'Compliance-Module' },
    Actions: [
      {
        Identifier: 'compliance-message',
        Type: 'MessageParticipant',
        Parameters: { Text: 'This call may be recorded.' },
        Transitions: { NextAction: 'module-end' },
      },
      { Identifier: 'module-end', Type: 'EndFlowModuleExecution', Parameters: {}, Transitions: {} },
    ],
  };

  const salesFlow = {
    Version: '2019-10-30',
    StartAction: 'sales-welcome',
    Metadata: { name: 'Sales-Flow' },
    Actions: [
      {
        Identifier: 'sales-welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome to sales' },
        Transitions: { NextAction: 'sales-queue' },
      },
      {
        Identifier: 'sales-queue',
        Type: 'UpdateContactTargetQueue',
        Parameters: { QueueId: arn('queue', 'sales-queue-id') },
        Transitions: { NextAction: 'sales-transfer' },
      },
      { Identifier: 'sales-transfer', Type: 'TransferContactToQueue', Parameters: {}, Transitions: {} },
    ],
  };

  const bundle = {
    flow: mainFlow,
    modules: { 'Compliance-Module': complianceModule },
    flows: { 'Sales-Flow': salesFlow },
    defaults: DEFAULTS,
  };

  const items = generateTestCases(bundle, { flowName: 'BM-Test-IaC-Flow', warn: () => {} });

  it('enumerates every menu path across the flow and its dependencies', () => {
    expect(Object.keys(items).sort()).toEqual([
      '1.1',
      '1.2',
      '1.Default',
      '1.Timeout',
      '2',
      'Default',
      'OutOfHour',
      'Timeout',
    ]);
  });

  it('inlines the prompts of an invoked module', () => {
    expect(messages(items['1.1'])).toEqual([
      'Welcome to the test flow',
      'This call may be recorded.',
      'Press one for technical issues. Press two for Sales.',
      'Press one for WiFi issues, press two for laptop issues.',
    ]);
  });

  it('returns from a module whose exit block is a plain EndFlowExecution', () => {
    // What DescribeContactFlowModule actually returns: the designer writes the
    // module's exit as EndFlowExecution rather than EndFlowModuleExecution. Read
    // as the contact ending, it would cut every path off at the module and leave
    // one test case per hours variant instead of one per menu path.
    const exported = {
      ...complianceModule,
      Actions: complianceModule.Actions.map((action) =>
        action.Identifier === 'module-end' ? { ...action, Type: 'EndFlowExecution' } : action
      ),
    };

    const fromExport = generateTestCases(
      { ...bundle, modules: { 'Compliance-Module': exported } },
      { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
    );

    expect(Object.keys(fromExport).sort()).toEqual(Object.keys(items).sort());
    expect(messages(fromExport['1.1'])).toEqual(messages(items['1.1']));
  });

  it('follows a transfer into another flow and uses that flow’s queue', () => {
    expect(messages(items['2'])).toEqual([
      'Welcome to the test flow',
      'This call may be recorded.',
      'Press one for technical issues. Press two for Sales.',
      'Welcome to sales',
    ]);
    expect(endsAtQueue(items['2'])).toBe(true);
    expect(items['2'].queue).toBe('sales-queue-id');
  });

  it('takes the queue id from the working queue set before the transfer', () => {
    expect(endsAtQueue(items['1.1'])).toBe(true);
    expect(items['1.1'].queue).toBe('tech-queue');
  });

  it('ends a disconnect path without a queue', () => {
    expect(endsAtQueue(items['1.2'])).toBe(false);
    expect(items['1.2'].queue).toBeUndefined();
  });

  it('reads the hours of operation id out of the flow itself', () => {
    expect(items['1.1'].hours_of_operation).toBe('hoo-123');
  });

  it('keeps the closed prompt out of the menu paths, which are mocked as open', () => {
    for (const [label, item] of Object.entries(items)) {
      if (label === 'OutOfHour') continue;
      expect(item.hours_of_operation_results).toBe('InHour');
      expect(messages(item)).not.toContain('We are closed');
    }
  });

  it('covers a menu timeout by withholding input on the prompt', () => {
    // A test case withholds input by observing the prompt and taking no action
    // at all. That is what the menu's InputTimeLimitExceeded branch means, so
    // the timeout block is the menu prompt with no Action on it.
    const timeout = chain(items['Timeout']);
    expect(messages(items['Timeout'])).toEqual([
      'Welcome to the test flow',
      'This call may be recorded.',
      'Press one for technical issues. Press two for Sales.',
    ]);
    expect(timeout[timeout.length - 1].Action).toBeUndefined();
    expect(endsAtQueue(items['Timeout'])).toBe(false);
  });

  it('covers a menu default by pressing a digit the menu does not offer', () => {
    // The no-match branch needs input that matches none of the conditions. The
    // menu offers 1 and 2, so 9 is what proves the branch was taken.
    const fallthrough = chain(items['Default']);
    expect(messages(items['Default'])).toEqual([
      'Welcome to the test flow',
      'This call may be recorded.',
      'Press one for technical issues. Press two for Sales.',
    ]);
    expect(fallthrough[fallthrough.length - 1].Action).toEqual({
      type: 'DtmfInput',
      user_action: '9',
    });
  });

  it('does not offer a digit the menu already uses as the no-match input', () => {
    // A menu that offers 9 would swallow the no-match input and take the 9
    // branch instead, so the generator has to pick something else.
    const nines = {
      ...bundle,
      flow: {
        ...mainFlow,
        Actions: mainFlow.Actions.map((action) =>
          action.Identifier === 'main-menu'
            ? {
                ...action,
                Transitions: {
                  NextAction: 'hangup',
                  Conditions: [
                    { NextAction: 'technical-menu', Condition: { Operator: 'Equals', Operands: ['9'] } },
                  ],
                },
              }
            : action
        ),
      },
    };
    const generated = generateTestCases(nines, { flowName: 'BM-Test-IaC-Flow', warn: () => {} });
    const fallthrough = chain(generated['Default']);
    expect(fallthrough[fallthrough.length - 1].Action?.user_action).not.toBe('9');
  });

  it('covers the closed side of the hours check as well, mocked as closed', () => {
    expect(messages(items['OutOfHour'])).toEqual(['We are closed']);
    expect(items['OutOfHour'].hours_of_operation_results).toBe('OutOfHour');
    expect(endsAtQueue(items['OutOfHour'])).toBe(false);
  });

  it('generates only the closed side when the definition asks for just that', () => {
    const closed = generateTestCases(
      { ...bundle, defaults: { ...DEFAULTS, hours_of_operation_results: 'OutOfHour' } },
      { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
    );
    expect(Object.keys(closed)).toEqual(['main']);
    expect(messages(closed['main'])).toEqual(['We are closed']);
    expect(closed['main'].hours_of_operation_results).toBe('OutOfHour');
  });

  it('takes an explicit list of hours results as the exact set to cover', () => {
    const listed = generateTestCases(
      { ...bundle, defaults: { ...DEFAULTS, hours_of_operation_results: ['InHour'] } },
      { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
    );
    expect(Object.keys(listed).sort()).toEqual([
      '1.1',
      '1.2',
      '1.Default',
      '1.Timeout',
      '2',
      'Default',
      'Timeout',
    ]);
  });

  // The same list, written in the values file instead of in the definition. A Connect
  // export is replaced whole every time the flow changes and takes anything added to it
  // by hand with it, so what the values file says beside it wins.
  it('takes that list out of the values file, over the definition’s own', () => {
    const listed = generateTestCases(
      { ...bundle, defaults: { ...DEFAULTS, hours_of_operation_results: ['InHour'] } },
      {
        flowName: 'BM-Test-IaC-Flow',
        declaredDefaults: { hours_of_operation_results: ['OutOfHour'] },
        warn: () => {},
      }
    );
    expect(Object.keys(listed)).toEqual(['main']);
    expect(messages(listed['main'])).toEqual(['We are closed']);
    expect(listed['main'].hours_of_operation_results).toBe('OutOfHour');
  });

  it('leaves the closed side alone when it goes where the open side goes', () => {
    const warnings: string[] = [];
    // Both sides of the check fall through to the welcome message, so a closed
    // test case would be a duplicate of an open one under a misleading label.
    const noClosedBranch = {
      ...bundle,
      flow: {
        ...mainFlow,
        Actions: mainFlow.Actions.map((action) =>
          action.Identifier === 'check-hoo'
            ? { ...action, Transitions: { NextAction: 'welcome' } }
            : action
        ),
      },
    };
    const generated = generateTestCases(noClosedBranch, {
      flowName: 'BM-Test-IaC-Flow',
      warn: (m) => warnings.push(m),
    });
    expect(Object.keys(generated).sort()).toEqual([
      '1.1',
      '1.2',
      '1.Default',
      '1.Timeout',
      '2',
      'Default',
      'Timeout',
    ]);
    expect(warnings.join('\n')).not.toContain('OutOfHour');
  });

  it('accepts a flow whose content is a JSON string, as the Connect API returns it', () => {
    const stringified = { ...bundle, flow: JSON.stringify(mainFlow) };
    const fromString = generateTestCases(stringified, { flowName: 'BM-Test-IaC-Flow', warn: () => {} });
    expect(Object.keys(fromString).sort()).toEqual(Object.keys(items).sort());
  });

  it('warns and stops the path when a transferred-to flow is missing', () => {
    const warnings: string[] = [];
    const withoutSales = generateTestCases(
      { ...bundle, flows: {} },
      { flowName: 'BM-Test-IaC-Flow', warn: (m) => warnings.push(m) }
    );
    expect(messages(withoutSales['2']).pop()).toBe('Press one for technical issues. Press two for Sales.');
    expect(warnings.join('\n')).toContain('transfers to a flow that is not in the bundle');
  });

  it('ends the path where it terminates when the flow names no queue', () => {
    // No configured fallback: asserting a transfer to a queue the branch does
    // not actually name would make the test case lie about the flow.
    const warnings: string[] = [];
    const noQueue = {
      ...bundle,
      flow: {
        ...mainFlow,
        Actions: mainFlow.Actions.map((action) =>
          action.Identifier === 'set-tech-queue'
            ? { ...action, Parameters: {} }
            : action
        ),
      },
    };
    const generated = generateTestCases(noQueue, {
      flowName: 'BM-Test-IaC-Flow',
      warn: (m) => warnings.push(m),
    });
    expect(generated['1.1'].queue).toBeUndefined();
    expect(endsAtQueue(generated['1.1'])).toBe(false);
    expect(warnings.join('\n')).toContain('names no queue id on that branch');
  });

  it('rejects a definition with no hours of operation anywhere', () => {
    expect(() =>
      generateTestCases(
        { menus: { root: { prompt: 'Press one', options: { '1': 'disconnect' } } } },
        { flowName: 'No-Hoo-Flow', warn: () => {} }
      )
    ).toThrow(/hours of operation/);
  });

  it('names the flow after the folder it was uploaded to, not the bundle', () => {
    // The folder has to match the contact flow in Connect, so a stale
    // "flow_name" left in the bundle must not be able to override it.
    const warnings: string[] = [];
    const renamed = generateTestCases(
      { ...bundle, flow_name: 'Some-Other-Flow' },
      { flowName: 'BM-Test-IaC-Flow', warn: (m) => warnings.push(m) }
    );
    for (const item of Object.values(renamed)) {
      expect(item['flow-name']).toBe('BM-Test-IaC-Flow');
    }
    expect(warnings.join('\n')).toContain('the folder wins');
  });

  it('rejects a definition that is neither an export nor a menu tree', () => {
    expect(() => generateTestCases({ something: 'else' }, { flowName: 'X' })).toThrow(
      /Unrecognised flow definition/
    );
  });

  describe('what the caller hears on hold', () => {
    const HOLD_TEXT =
      'Thank you for calling. Your call is very important to us and will be answered in the order it was received.';

    // A real customer queue flow: one Loop prompts block alternating a spoken
    // message with hold music, and nothing after it.
    const queueFlow = (messages: unknown[], name = 'Default customer queue') => ({
      Version: '2019-10-30',
      StartAction: 'hold-loop',
      Metadata: { name },
      Actions: [
        {
          Identifier: 'hold-loop',
          Type: 'MessageParticipantIteratively',
          Parameters: { Messages: messages },
          Transitions: { Errors: [], Conditions: [] },
        },
      ],
    });

    const withQueueFlow = (extra: Record<string, unknown>) =>
      generateTestCases(
        {
          ...bundle,
          flows: { ...bundle.flows, ...(extra.flows as Record<string, unknown>) },
          defaults: { ...DEFAULTS, ...(extra.defaults as Record<string, unknown>) },
        },
        { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
      );

    const isHoldBlock = (name: string) => name.startsWith('queue_message_');

    // The hold messages in chain order. They are the tail of the chain: Connect
    // starts the transfer first, and the queue flow plays them once it has.
    const holdMessages = (item: Record<string, any>): string[] =>
      blockNames(item)
        .filter(isHoldBlock)
        .map((name) => item[name].Observe.message);

    // The flow's own blocks, without whatever the queue flow adds on the end.
    const flowBlockNames = (item: Record<string, any>): string[] =>
      blockNames(item).filter((name) => !isHoldBlock(name));

    it('asserts the transfer first, then what the queue flow plays after it', () => {
      const generated = withQueueFlow({
        flows: { 'Default customer queue': queueFlow([{ Text: HOLD_TEXT }]) },
        defaults: { customer_queue_flow: 'Default customer queue' },
      });

      // Connect starts the transfer before the customer queue flow speaks, so
      // check_queue comes first and the hold message hangs off it. Asserted the
      // other way round, the transfer is already over by the time the test case
      // starts watching for it and the observation fails on a contact that queued.
      expect(endsAtQueue(generated['1.1'])).toBe(true);
      expect(generated['1.1'].check_queue).toEqual({ next: 'queue_message_1' });
      expect(blockNames(generated['1.1']).at(-1)).toBe('queue_message_1');
      expect((generated['1.1'].queue_message_1 as Block).next).toBeUndefined();
      expect(holdMessages(generated['1.1'])).toEqual([HOLD_TEXT]);
    });

    it('reads every text entry of the message list, and only those', () => {
      const generated = withQueueFlow({
        flows: {
          'Default customer queue': queueFlow([
            { Text: HOLD_TEXT },
            { PromptId: arn('prompt', 'hold-music') },
            { Text: 'Your call is still in the queue.' },
          ]),
        },
        defaults: { customer_queue_flow: 'Default customer queue' },
      });

      expect(holdMessages(generated['1.1'])).toEqual([
        HOLD_TEXT,
        'Your call is still in the queue.',
      ]);
    });

    it('says nothing about a queue flow that only plays recorded audio', () => {
      const generated = withQueueFlow({
        flows: {
          'Default customer queue': queueFlow([{ PromptId: arn('prompt', 'hold-music') }]),
        },
        defaults: { customer_queue_flow: 'Default customer queue' },
      });

      expect(holdMessages(generated['1.1'])).toEqual([]);
      // The chain is the flow's own blocks and nothing else, still ending on the
      // transfer the submenu leads to.
      expect(blockNames(generated['1.1'])).toEqual(flowBlockNames(items['1.1']));
      expect(endsAtQueue(generated['1.1'])).toBe(true);
    });

    it('stops at the queue flow’s first branch rather than guessing one', () => {
      // Past a check of how many agents are free, what the caller hears depends
      // on the answer, and a test case cannot assert "one of these two".
      const branching = {
        Version: '2019-10-30',
        StartAction: 'agents-free',
        Metadata: { name: 'Default customer queue' },
        Actions: [
          {
            Identifier: 'agents-free',
            Type: 'CheckMetricData',
            Parameters: { MetricName: 'NumberOfAgentsAvailable' },
            Transitions: {
              NextAction: 'still-waiting',
              Conditions: [
                { NextAction: 'coming-now', Condition: { Operator: 'GreaterThan', Operands: ['0'] } },
              ],
            },
          },
          {
            Identifier: 'coming-now',
            Type: 'MessageParticipant',
            Parameters: { Text: 'An agent is on the way.' },
            Transitions: {},
          },
          {
            Identifier: 'still-waiting',
            Type: 'MessageParticipant',
            Parameters: { Text: 'All our agents are busy.' },
            Transitions: {},
          },
        ],
      };

      const generated = withQueueFlow({
        flows: { 'Default customer queue': branching },
        defaults: { customer_queue_flow: 'Default customer queue' },
      });

      expect(holdMessages(generated['1.1'])).toEqual([]);
    });

    it('prefers the queue flow the flow sets itself over the default', () => {
      const OWN_TEXT = 'You are through to technical support, please hold.';
      const withHook = {
        ...mainFlow,
        Metadata: {
          ...mainFlow.Metadata,
          ActionMetadata: {
            ...mainFlow.Metadata.ActionMetadata,
            'set-queue-flow': {
              parameters: { EventHooks: { CustomerQueue: { displayName: 'Tech-Queue-Flow' } } },
            },
          },
        },
        Actions: mainFlow.Actions.map((action) =>
          action.Identifier === 'set-tech-queue'
            ? { ...action, Transitions: { NextAction: 'set-queue-flow' } }
            : action
        ).concat([
          {
            Identifier: 'set-queue-flow',
            Type: 'UpdateContactEventHooks',
            Parameters: { EventHooks: { CustomerQueue: arn('contact-flow', 'tech-queue-flow-id') } },
            Transitions: { NextAction: 'to-queue' },
          } as any,
        ]),
      };

      const generated = generateTestCases(
        {
          flow: withHook,
          modules: bundle.modules,
          flows: {
            ...bundle.flows,
            'Default customer queue': queueFlow([{ Text: HOLD_TEXT }]),
            'Tech-Queue-Flow': queueFlow([{ Text: OWN_TEXT }], 'Tech-Queue-Flow'),
          },
          defaults: { ...DEFAULTS, customer_queue_flow: 'Default customer queue' },
        },
        { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
      );

      // 1.1 sets its own queue flow on the way to the transfer; 2 transfers out
      // to the sales flow, which never sets one, so it falls back to the default.
      expect(holdMessages(generated['1.1'])).toEqual([OWN_TEXT]);
      expect(holdMessages(generated['2'])).toEqual([HOLD_TEXT]);
    });

    it('warns about a queue flow that is missing from the bundle', () => {
      const warnings: string[] = [];
      generateTestCases(
        { ...bundle, defaults: { ...DEFAULTS, customer_queue_flow: 'Nowhere-To-Be-Found' } },
        { flowName: 'BM-Test-IaC-Flow', warn: (m) => warnings.push(m) }
      );
      expect(warnings.join('\n')).toContain('Nowhere-To-Be-Found');
    });

    it('leaves a path that never reaches a queue alone', () => {
      const generated = withQueueFlow({
        flows: { 'Default customer queue': queueFlow([{ Text: HOLD_TEXT }]) },
        defaults: { customer_queue_flow: 'Default customer queue' },
      });

      // 1.2 hangs up on the technical submenu instead of queueing.
      expect(generated['1.2'].queue).toBeUndefined();
      expect(holdMessages(generated['1.2'])).toEqual([]);
      expect(endsAtQueue(generated['1.2'])).toBe(false);
    });

    // "Set working queue" on its own queues nobody: the documented rule is that a
    // "Transfer to queue" block has to follow it. A branch that sets the queue,
    // names the flow to play on hold, and then ends the flow is one that was wired
    // to the wrong terminal block - the caller hears "please hold" and is hung up
    // on - and there is nothing for the test case to assert but that.
    describe('a branch that sets the queue and then ends the flow', () => {
      // The technical branch, wired the way the published flow wires its
      // authorisation branches: set the queue, set the hold flow, End flow / Resume.
      const viaHoldFlow = (afterHook: string, endType = 'EndFlowExecution') => ({
        ...mainFlow,
        Metadata: {
          ...mainFlow.Metadata,
          ActionMetadata: {
            ...mainFlow.Metadata.ActionMetadata,
            'set-queue-flow': {
              parameters: { EventHooks: { CustomerQueue: { displayName: 'Tech-Queue-Flow' } } },
            },
          },
        },
        Actions: mainFlow.Actions.map((action) =>
          action.Identifier === 'set-tech-queue'
            ? { ...action, Transitions: { NextAction: 'set-queue-flow' } }
            : action
        ).concat([
          {
            Identifier: 'set-queue-flow',
            Type: 'UpdateContactEventHooks',
            Parameters: { EventHooks: { CustomerQueue: arn('contact-flow', 'tech-queue-flow-id') } },
            Transitions: { NextAction: afterHook },
          },
          { Identifier: 'end-flow', Type: endType, Parameters: {}, Transitions: {} },
        ] as any[]),
      });

      const endsWithoutTransferring = (endType?: string) => viaHoldFlow('end-flow', endType);

      const generateFrom = (flow: unknown) => {
        const warnings: string[] = [];
        const generated = generateTestCases(
          {
            flow,
            modules: bundle.modules,
            flows: {
              ...bundle.flows,
              'Tech-Queue-Flow': queueFlow([{ Text: HOLD_TEXT }], 'Tech-Queue-Flow'),
            },
            defaults: DEFAULTS,
          },
          { flowName: 'BM-Test-IaC-Flow', warn: (m) => warnings.push(m) }
        );
        return { generated, warnings };
      };

      it('asserts no queue and no hold message, because neither happens', () => {
        const { generated } = generateFrom(endsWithoutTransferring());

        expect(generated['1.1'].queue).toBeUndefined();
        expect(endsAtQueue(generated['1.1'])).toBe(false);
        expect(holdMessages(generated['1.1'])).toEqual([]);
      });

      it('says which block ended the flow, and which block set the queue', () => {
        const { warnings } = generateFrom(endsWithoutTransferring());
        const reported = warnings.filter((m) => m.includes('nothing on the branch transfers'));

        expect(reported).toHaveLength(1);
        expect(reported[0]).toContain('block end-flow');
        expect(reported[0]).toContain('tech-queue');
        expect(reported[0]).toContain('set-tech-queue');
        expect(reported[0]).toContain('"Transfer to queue"');
      });

      it('has both once the branch runs into a transfer', () => {
        // The same flow with the one wire put back, which is the fix the warning
        // asks for: the queue is asserted, and the hold flow it set is read.
        const { generated, warnings } = generateFrom(viaHoldFlow('to-queue'));

        expect(generated['1.1'].queue).toBe('tech-queue');
        expect(endsAtQueue(generated['1.1'])).toBe(true);
        expect(holdMessages(generated['1.1'])).toEqual([HOLD_TEXT]);
        expect(warnings.join('\n')).not.toContain('nothing on the branch transfers');
      });

      it('says nothing about a queue set only to read its hours', () => {
        // A flow that sets the working queue so the hours check can read it and
        // then hangs up out of hours is doing that on purpose: it names no hold
        // flow, because nobody is going on hold.
        const { warnings } = generateFrom({
          ...mainFlow,
          Actions: mainFlow.Actions.map((action) =>
            action.Identifier === 'set-tech-queue'
              ? { ...action, Transitions: { NextAction: 'hangup' } }
              : action
          ),
        });

        expect(warnings.join('\n')).not.toContain('nothing on the branch transfers');
      });

      it('says nothing about a branch that hangs up rather than ending the flow', () => {
        // A Disconnect block is an author saying "hang up here" in as many words.
        const { warnings } = generateFrom(endsWithoutTransferring('DisconnectParticipant'));

        expect(warnings.join('\n')).not.toContain('nothing on the branch transfers');
      });
    });
  });

  // A flow that announces "$.Attributes.ooo_message" says whatever a "Set contact
  // attributes" block earlier on the path put there. The reference itself is never
  // what the caller hears, so the value has to be followed to know what to assert.
  describe('a prompt that plays back a contact attribute', () => {
    // A flow that is nothing but a straight run of blocks: one test case, labelled
    // "main". Each action only says what it is - the transition to the next one,
    // and the disconnect on the end, are filled in.
    const straightFlow = (actions: any[]) => ({
      Version: '2019-10-30',
      StartAction: actions[0].Identifier,
      Metadata: { name: 'BM-Test-IaC-Flow' },
      Actions: [
        ...actions.map((action, index) => ({
          Transitions: { NextAction: actions[index + 1]?.Identifier ?? 'hangup' },
          ...action,
        })),
        { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
      ],
    });

    // What the caller hears walking that line, in order.
    const heard = (actions: any[], warn: (message: string) => void = () => {}) => {
      const generated = generateTestCases(
        { flow: straightFlow(actions), defaults: { ...DEFAULTS, hours_of_operation: 'hoo-123' } },
        { flowName: 'BM-Test-IaC-Flow', warn }
      );
      return generated.main ? messages(generated.main) : [];
    };

    const sets = (attributes: Record<string, string>, extra: Record<string, unknown> = {}) => ({
      Identifier: `set-${Object.keys(attributes).join('-')}`,
      Type: 'UpdateContactAttributes',
      Parameters: { Attributes: attributes, TargetContact: 'Current', ...extra },
    });

    const says = (identifier: string, text: string) => ({
      Identifier: identifier,
      Type: 'MessageParticipant',
      Parameters: { Text: text },
    });

    it('asserts the value the flow set, for a prompt that says nothing else', () => {
      // There is no literal text in "$.Attributes.ooo_message" at all, so without
      // the value the block is dropped - and a path whose only prompt is dropped
      // stops being a test case, which is how an out-of-hours announcement goes
      // missing rather than merely unasserted.
      expect(
        heard([
          sets({ ooo_message: 'We are closed until Monday.' }),
          says('announce', '$.Attributes.ooo_message'),
        ])
      ).toEqual(['We are closed until Monday.']);
    });

    it('reads the bracketed form of the reference too', () => {
      // Which is what the designer writes when the attribute name is not a bare
      // word, so the dotted form could not have referred to this one.
      expect(
        heard([
          sets({ 'ooo-message': 'We are closed until Monday.' }),
          says('announce', "Please note: $.Attributes['ooo-message']"),
        ])
      ).toEqual(['Please note: We are closed until Monday.']);
    });

    it('only knows the value from the block that sets it onwards', () => {
      expect(
        heard([
          says('early', 'One moment. $.Attributes.desk is where you are going.'),
          sets({ desk: 'the sales desk' }),
          says('late', 'Putting you through to $.Attributes.desk now.'),
        ])
      ).toEqual(['is where you are going.', 'Putting you through to the sales desk now.']);
    });

    it('keeps a value that is itself interpolated unknown', () => {
      // "$.External.desk" is whatever a Lambda returned on the call, so putting it
      // back would assert text no caller ever hears.
      expect(
        heard([
          sets({ desk: '$.External.desk' }),
          says('greet', 'Putting you through to $.Attributes.desk now.'),
        ])
      ).toEqual(['Putting you through to']);
    });

    it('ignores a block that writes to the other contact', () => {
      // TargetContact "Related" sets attributes on a different contact, which is
      // not the one whose prompts this test case asserts.
      expect(
        heard([
          sets({ desk: 'the sales desk' }, { TargetContact: 'Related' }),
          says('greet', 'Putting you through to $.Attributes.desk now.'),
        ])
      ).toEqual(['Putting you through to']);
    });

    it('says why a prompt was left out when there is nothing to assert', () => {
      const warnings: string[] = [];
      expect(
        heard([says('announce', '$.Attributes.filled_in_by_lambda'), says('bye', 'Goodbye.')], (m) =>
          warnings.push(m)
        )
      ).toEqual(['Goodbye.']);

      expect(warnings.join('\n')).toContain('filled_in_by_lambda');
      expect(warnings.join('\n')).toContain('left out of the test case');
    });

    it('keeps a value to the branch that set it', () => {
      const generated = generateTestCases(
        {
          flow: {
            Version: '2019-10-30',
            StartAction: 'menu',
            Metadata: { name: 'BM-Test-IaC-Flow' },
            Actions: [
              {
                Identifier: 'menu',
                Type: 'GetParticipantInput',
                Parameters: { Text: 'Press one for sales, press two for support.' },
                Transitions: {
                  NextAction: 'greet',
                  Conditions: [
                    { NextAction: 'set-sales', Condition: { Operator: 'Equals', Operands: ['1'] } },
                    { NextAction: 'set-support', Condition: { Operator: 'Equals', Operands: ['2'] } },
                  ],
                },
              },
              {
                Identifier: 'set-sales',
                Type: 'UpdateContactAttributes',
                Parameters: { Attributes: { desk: 'the sales desk' } },
                Transitions: { NextAction: 'greet' },
              },
              {
                Identifier: 'set-support',
                Type: 'UpdateContactAttributes',
                Parameters: { Attributes: { desk: 'the support desk' } },
                Transitions: { NextAction: 'greet' },
              },
              {
                Identifier: 'greet',
                Type: 'MessageParticipant',
                Parameters: { Text: 'Putting you through to $.Attributes.desk now.' },
                Transitions: { NextAction: 'hangup' },
              },
              { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
            ],
          },
          defaults: { ...DEFAULTS, hours_of_operation: 'hoo-123' },
        },
        { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
      );

      // One block, three answers: neither branch's value leaks into the other, and
      // the no-match path reaches the same prompt having set nothing at all.
      expect(messages(generated['1']).at(-1)).toBe('Putting you through to the sales desk now.');
      expect(messages(generated['2']).at(-1)).toBe('Putting you through to the support desk now.');
      expect(messages(generated['Default']).at(-1)).toBe('Putting you through to');
    });

    it('warns once per block rather than once per path that walks it', () => {
      const warnings: string[] = [];
      generateTestCases(
        {
          flow: {
            Version: '2019-10-30',
            StartAction: 'announce',
            Metadata: { name: 'BM-Test-IaC-Flow' },
            Actions: [
              {
                Identifier: 'announce',
                Type: 'MessageParticipant',
                Parameters: { Text: '$.Attributes.filled_in_by_lambda' },
                Transitions: { NextAction: 'menu' },
              },
              {
                Identifier: 'menu',
                Type: 'GetParticipantInput',
                Parameters: { Text: 'Press one for sales, press two for support.' },
                Transitions: {
                  NextAction: 'hangup',
                  Conditions: [
                    { NextAction: 'hangup', Condition: { Operator: 'Equals', Operands: ['1'] } },
                    { NextAction: 'hangup', Condition: { Operator: 'Equals', Operands: ['2'] } },
                  ],
                },
              },
              { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
            ],
          },
          defaults: { ...DEFAULTS, hours_of_operation: 'hoo-123' },
        },
        { flowName: 'BM-Test-IaC-Flow', warn: (m) => warnings.push(m) }
      );

      // Four paths walk that announcement, and it is missing the attribute on all
      // of them for the same reason. Saying so four times buries everything else.
      expect(warnings.filter((m) => m.includes('filled_in_by_lambda'))).toHaveLength(1);
    });

    it('still knows an attribute the flow set once the queue flow plays it back', () => {
      // Attributes are on the contact, so they are still set when Connect runs the
      // customer queue flow on the way into the queue.
      const withAttribute = {
        ...mainFlow,
        Actions: mainFlow.Actions.map((action) =>
          action.Identifier === 'set-tech-queue'
            ? { ...action, Transitions: { NextAction: 'set-desk' } }
            : action
        ).concat([
          {
            Identifier: 'set-desk',
            Type: 'UpdateContactAttributes',
            Parameters: { Attributes: { desk: 'the technical desk' } },
            Transitions: { NextAction: 'to-queue' },
          } as any,
        ]),
      };

      const generated = generateTestCases(
        {
          flow: withAttribute,
          modules: bundle.modules,
          flows: {
            ...bundle.flows,
            'Default customer queue': {
              Version: '2019-10-30',
              StartAction: 'hold',
              Metadata: { name: 'Default customer queue' },
              Actions: [
                {
                  Identifier: 'hold',
                  Type: 'MessageParticipant',
                  Parameters: { Text: 'You are holding for $.Attributes.desk.' },
                  Transitions: {},
                },
              ],
            },
          },
          defaults: { ...DEFAULTS, customer_queue_flow: 'Default customer queue' },
        },
        { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
      );

      // 1.1 sets it on the way to the queue; 2 transfers out to the sales flow,
      // which sets nothing, so only the literal text around it survives there.
      expect(messages(generated['1.1']).at(-1)).toBe('You are holding for the technical desk.');
      expect(messages(generated['2']).at(-1)).toBe('You are holding for');
    });

    it('lets the queue flow set an attribute of its own before it speaks', () => {
      const generated = generateTestCases(
        {
          ...bundle,
          flows: {
            ...bundle.flows,
            'Default customer queue': {
              Version: '2019-10-30',
              StartAction: 'set-position',
              Metadata: { name: 'Default customer queue' },
              Actions: [
                {
                  Identifier: 'set-position',
                  Type: 'UpdateContactAttributes',
                  Parameters: { Attributes: { position: 'third in the queue' } },
                  Transitions: { NextAction: 'hold' },
                },
                {
                  Identifier: 'hold',
                  Type: 'MessageParticipant',
                  Parameters: { Text: 'You are $.Attributes.position.' },
                  Transitions: {},
                },
              ],
            },
          },
          defaults: { ...DEFAULTS, customer_queue_flow: 'Default customer queue' },
        },
        { flowName: 'BM-Test-IaC-Flow', warn: () => {} }
      );

      expect(messages(generated['1.1']).at(-1)).toBe('You are third in the queue.');
    });
  });
});

describe('reading the queue and hours off the Connect instance', () => {
  const QUEUE_ID = '11111111-1111-1111-1111-111111111111';
  const QUEUE_HOURS_ID = '22222222-2222-2222-2222-222222222222';
  const NAMED_HOURS_ID = '33333333-3333-3333-3333-333333333333';

  // The queue is only in the metadata beside the block, as the designer leaves
  // it, and the hours check names nothing at all - it checks that queue's hours.
  const flow = {
    Version: '2019-10-30',
    StartAction: 'welcome',
    Metadata: {
      name: 'Hours-From-Queue-Flow',
      ActionMetadata: { 'set-queue': { queue: { text: 'BasicQueue' } } },
    },
    Actions: [
      {
        Identifier: 'welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome' },
        Transitions: { NextAction: 'main-menu' },
      },
      {
        Identifier: 'main-menu',
        Type: 'GetParticipantInput',
        Parameters: { Text: 'Press one for sales, press two to hang up.' },
        Transitions: {
          NextAction: 'hangup',
          Conditions: [
            { NextAction: 'set-queue', Condition: { Operator: 'Equals', Operands: ['1'] } },
            { NextAction: 'hangup', Condition: { Operator: 'Equals', Operands: ['2'] } },
          ],
        },
      },
      {
        Identifier: 'set-queue',
        Type: 'UpdateContactTargetQueue',
        Parameters: {},
        Transitions: { NextAction: 'check-hoo' },
      },
      {
        Identifier: 'check-hoo',
        Type: 'CheckHoursOfOperation',
        Parameters: {},
        Transitions: {
          NextAction: 'to-queue',
          Conditions: [{ NextAction: 'hangup', Condition: { Operator: 'Equals', Operands: ['False'] } }],
        },
      },
      { Identifier: 'to-queue', Type: 'TransferContactToQueue', Parameters: {}, Transitions: {} },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  function fakeLookups(calls: string[] = []): ConnectLookups {
    return {
      async queueIdForName(name) {
        calls.push(`ListQueues(${name})`);
        return name.toLowerCase() === 'basicqueue' ? QUEUE_ID : undefined;
      },
      async hoursOfOperationIdForName(name) {
        calls.push(`ListHoursOfOperations(${name})`);
        return name.toLowerCase() === 'office hours' ? NAMED_HOURS_ID : undefined;
      },
      async hoursOfOperationIdForQueue(queueId) {
        calls.push(`DescribeQueue(${queueId})`);
        return queueId === QUEUE_ID ? QUEUE_HOURS_ID : undefined;
      },
      async customerQueueFlowIdForName(name) {
        calls.push(`ListContactFlows(${name})`);
        return undefined;
      },
      // This flow refers to no other flow or module, so nothing here is asked for.
      async contactFlowDefinition(id) {
        calls.push(`DescribeContactFlow(${id})`);
        return undefined;
      },
      async contactFlowModuleDefinition(id) {
        calls.push(`DescribeContactFlowModule(${id})`);
        return undefined;
      },
    };
  }

  it('resolves a queue named only in the flow metadata to its id', async () => {
    const items = await generateTestCasesWithConnect(
      { flow },
      { flowName: 'Hours-From-Queue-Flow', warn: () => {} },
      fakeLookups()
    );
    expect(items['1'].queue).toBe(QUEUE_ID);
    expect(endsAtQueue(items['1'])).toBe(true);
  });

  it('reads the hours of operation off the queue the check applies to', async () => {
    const calls: string[] = [];
    const items = await generateTestCasesWithConnect(
      { flow },
      { flowName: 'Hours-From-Queue-Flow', warn: () => {} },
      fakeLookups(calls)
    );
    expect(items['1'].hours_of_operation).toBe(QUEUE_HOURS_ID);
    expect(calls).toContain(`DescribeQueue(${QUEUE_ID})`);
  });

  it('shares those hours with a path that never reaches a queue', async () => {
    const items = await generateTestCasesWithConnect(
      { flow },
      { flowName: 'Hours-From-Queue-Flow', warn: () => {} },
      fakeLookups()
    );
    expect(items['2'].queue).toBeUndefined();
    expect(items['2'].hours_of_operation).toBe(QUEUE_HOURS_ID);
  });

  it('resolves hours named in the flow by display name', async () => {
    const named = {
      flow: {
        ...flow,
        Metadata: {
          ...flow.Metadata,
          ActionMetadata: {
            ...flow.Metadata.ActionMetadata,
            'check-hoo': { hoursOfOperation: { text: 'Office Hours' } },
          },
        },
      },
    };
    const items = await generateTestCasesWithConnect(
      named,
      { flowName: 'Hours-From-Queue-Flow', warn: () => {} },
      fakeLookups()
    );
    expect(items['1'].hours_of_operation).toBe(NAMED_HOURS_ID);
  });

  it('lets the flow win over hours written in the bundle', async () => {
    // The flow settles the hours - via the queue its check applies to - so the
    // bundle value is not reached. Hours the flow does not settle fall back to
    // it, which is how a menu tree gets its hours at all.
    const items = await generateTestCasesWithConnect(
      { flow, defaults: { hours_of_operation: NAMED_HOURS_ID } },
      { flowName: 'Hours-From-Queue-Flow', warn: () => {} },
      fakeLookups()
    );
    expect(items['1'].hours_of_operation).toBe(QUEUE_HOURS_ID);
  });

  it('only walks the closed side for the paths that reach the hours check', async () => {
    // Option 2 hangs up before the check, so it plays out the same whichever way
    // the check is mocked and stays a single test case.
    const items = await generateTestCasesWithConnect(
      { flow },
      { flowName: 'Hours-From-Queue-Flow', warn: () => {} },
      fakeLookups()
    );
    expect(Object.keys(items).sort()).toEqual(['1', '2', 'Default', 'OutOfHour.1', 'Timeout']);
    expect(items['OutOfHour.1'].hours_of_operation_results).toBe('OutOfHour');
    expect(items['OutOfHour.1'].hours_of_operation).toBe(QUEUE_HOURS_ID);
    expect(endsAtQueue(items['OutOfHour.1'])).toBe(false);
  });

  it('warns and drops the transfer when the named queue is not on the instance', async () => {
    const warnings: string[] = [];
    const unknownQueue = {
      flow: {
        ...flow,
        Metadata: {
          ...flow.Metadata,
          ActionMetadata: { 'set-queue': { queue: { text: 'RetiredQueue' } } },
        },
      },
      // Nothing on the path resolves to a queue, so there is no queue to read
      // hours off either and the definition has to supply them.
      defaults: { hours_of_operation: NAMED_HOURS_ID },
    };
    const items = await generateTestCasesWithConnect(
      unknownQueue,
      { flowName: 'Hours-From-Queue-Flow', warn: (m) => warnings.push(m) },
      fakeLookups()
    );
    expect(warnings.join('\n')).toContain('No queue named "RetiredQueue"');
    expect(items['1'].queue).toBeUndefined();
    expect(endsAtQueue(items['1'])).toBe(false);
    expect(items['1'].hours_of_operation).toBe(NAMED_HOURS_ID);
  });
});

// Every test case carries an hours of operation id, because Connect mocks the
// check by resource rather than by block - so a flow that checks hours nowhere
// and queues nowhere they can be read off generates nothing at all without one.
// DEFAULT_HOURS_OF_OPERATION on the generator is that last resort; the handler
// passes it in as options.defaults, which is what these exercise.
describe('the account-wide hours of operation to fall back on', () => {
  const ENV_HOURS_ID = '44444444-4444-4444-4444-444444444444';
  const NAMED_HOURS_ID = '33333333-3333-3333-3333-333333333333';
  const QUEUE_ID = '11111111-1111-1111-1111-111111111111';
  const QUEUE_HOURS_ID = '22222222-2222-2222-2222-222222222222';

  // Nothing here settles the hours: no check block, and no branch reaches a queue.
  const promptsOnly = {
    Version: '2019-10-30',
    StartAction: 'welcome',
    Metadata: { name: 'Prompts-Only-Flow', ActionMetadata: {} },
    Actions: [
      {
        Identifier: 'welcome',
        Type: 'MessageParticipant',
        Parameters: { Text: 'Welcome. This line is not monitored.' },
        Transitions: { NextAction: 'hangup' },
      },
      { Identifier: 'hangup', Type: 'DisconnectParticipant', Parameters: {}, Transitions: {} },
    ],
  };

  function fakeLookups(calls: string[] = []): ConnectLookups {
    return {
      async queueIdForName(name) {
        calls.push(`ListQueues(${name})`);
        return name.toLowerCase() === 'basicqueue' ? QUEUE_ID : undefined;
      },
      async hoursOfOperationIdForName(name) {
        calls.push(`ListHoursOfOperations(${name})`);
        return name.toLowerCase() === 'rsa business hours' ? NAMED_HOURS_ID : undefined;
      },
      async hoursOfOperationIdForQueue(queueId) {
        calls.push(`DescribeQueue(${queueId})`);
        return queueId === QUEUE_ID ? QUEUE_HOURS_ID : undefined;
      },
      async customerQueueFlowIdForName(name) {
        calls.push(`ListContactFlows(${name})`);
        return undefined;
      },
      async contactFlowDefinition(id) {
        calls.push(`DescribeContactFlow(${id})`);
        return undefined;
      },
      async contactFlowModuleDefinition(id) {
        calls.push(`DescribeContactFlowModule(${id})`);
        return undefined;
      },
    };
  }

  it('covers a flow that would otherwise generate nothing', async () => {
    const items = await generateTestCasesWithConnect(
      { flow: promptsOnly },
      {
        flowName: 'Prompts-Only-Flow',
        defaults: { hours_of_operation: ENV_HOURS_ID },
        warn: () => {},
      },
      fakeLookups()
    );
    expect(Object.keys(items)).toEqual(['main']);
    expect(items['main'].hours_of_operation).toBe(ENV_HOURS_ID);
    expect(items['main'].hours_of_operation_results).toBe('InHour');
  });

  it('says so plainly when there is no default either', async () => {
    await expect(
      generateTestCasesWithConnect(
        { flow: promptsOnly },
        { flowName: 'Prompts-Only-Flow', warn: () => {} },
        fakeLookups()
      )
    ).rejects.toThrow(/DEFAULT_HOURS_OF_OPERATION/);
  });

  // An operations team knows the hours by the name on the console, not by a uuid,
  // so the default is allowed to be either.
  it('resolves a default given as a name off the instance', async () => {
    const calls: string[] = [];
    const items = await generateTestCasesWithConnect(
      { flow: promptsOnly },
      {
        flowName: 'Prompts-Only-Flow',
        defaults: { hours_of_operation: 'RSA Business Hours' },
        warn: () => {},
      },
      fakeLookups(calls)
    );
    expect(items['main'].hours_of_operation).toBe(NAMED_HOURS_ID);
    // Once for the whole flow, not once per test case.
    expect(calls.filter((call) => call.startsWith('ListHoursOfOperations'))).toEqual([
      'ListHoursOfOperations(RSA Business Hours)',
    ]);
  });

  it('warns and still fails when the named default is not on this instance', async () => {
    const warnings: string[] = [];
    await expect(
      generateTestCasesWithConnect(
        { flow: promptsOnly },
        {
          flowName: 'Prompts-Only-Flow',
          defaults: { hours_of_operation: 'Hours That Were Renamed' },
          warn: (m) => warnings.push(m),
        },
        fakeLookups()
      )
    ).rejects.toThrow(/no hours of operation id/);
    expect(warnings.join('\n')).toContain('No hours of operation named "Hours That Were Renamed"');
    expect(warnings.join('\n')).toContain('DEFAULT_HOURS_OF_OPERATION');
  });

  it('takes an ARN as readily as an id', async () => {
    const items = await generateTestCasesWithConnect(
      {
        flow: promptsOnly,
        defaults: {
          hours_of_operation: `arn:aws:connect:af-south-1:687244881512:instance/6e669f6f-3783-4c0e-ac76-4f531575015d/operating-hours/${ENV_HOURS_ID}`,
        },
      },
      { flowName: 'Prompts-Only-Flow', warn: () => {} },
      fakeLookups()
    );
    expect(items['main'].hours_of_operation).toBe(ENV_HOURS_ID);
  });

  // The whole point of reading hours per branch is that one flow can check two
  // different sets of hours. An account-wide default must not flatten that.
  it('loses to the hours the flow itself settles', async () => {
    const withQueue = {
      Version: '2019-10-30',
      StartAction: 'welcome',
      Metadata: {
        name: 'Hours-From-Queue-Flow',
        ActionMetadata: { 'set-queue': { queue: { text: 'BasicQueue' } } },
      },
      Actions: [
        {
          Identifier: 'welcome',
          Type: 'MessageParticipant',
          Parameters: { Text: 'Welcome' },
          Transitions: { NextAction: 'set-queue' },
        },
        {
          Identifier: 'set-queue',
          Type: 'UpdateContactTargetQueue',
          Parameters: {},
          Transitions: { NextAction: 'check-hoo' },
        },
        {
          Identifier: 'check-hoo',
          Type: 'CheckHoursOfOperation',
          Parameters: {},
          Transitions: { NextAction: 'to-queue' },
        },
        { Identifier: 'to-queue', Type: 'TransferContactToQueue', Parameters: {}, Transitions: {} },
      ],
    };
    const items = await generateTestCasesWithConnect(
      { flow: withQueue },
      {
        flowName: 'Hours-From-Queue-Flow',
        defaults: { hours_of_operation: ENV_HOURS_ID },
        warn: () => {},
      },
      fakeLookups()
    );
    expect(items['main'].hours_of_operation).toBe(QUEUE_HOURS_ID);
  });

  it('loses to a default the definition declares for itself', async () => {
    const items = await generateTestCasesWithConnect(
      { flow: promptsOnly, defaults: { hours_of_operation: NAMED_HOURS_ID } },
      {
        flowName: 'Prompts-Only-Flow',
        defaults: { hours_of_operation: ENV_HOURS_ID },
        warn: () => {},
      },
      fakeLookups()
    );
    expect(items['main'].hours_of_operation).toBe(NAMED_HOURS_ID);
  });
});

// What the Connect designer gives you when you export a flow is the flow alone:
// the module it invokes is an id and the queue flow it sets is an ARN, and the
// prompts the caller hears in those live in the resources themselves. Reading them
// off the instance is what lets that export be uploaded on its own.
describe('reading the flows and modules a definition names off the instance', () => {
  const bundle = deployedBundle();

  // The two resources BM-Test-IaC-Flow names, and the ids it names them by. Should
  // the flow ever point somewhere else, these tests are meant to fail.
  const MODULE_ID = 'ac128e1d-2a40-4c2c-9cf1-4c11cd87a4cd';
  const QUEUE_FLOW_ID = '384ed7f5-f4ee-4e84-a33c-b4b5bcb72c4e';
  // The second queue flow, set by the sales branch alone.
  const SALES_QUEUE_FLOW_ID = '2ef41232-837d-4c60-bd48-ca3630b25531';
  // And the flow the decommissioned branch transfers to, which is a flow the caller
  // carries on inside rather than one that plays over a queue.
  const TRANSFER_TARGET_ID = 'a37b12da-3217-4e34-ac9a-20bee93059de';
  // What that flow is called in the console, which is the only handle on it for a
  // flow that sets no event hook naming its id.
  const QUEUE_FLOW_NAME = 'Default customer queue';
  const queueFlow = customerQueueFlow;

  // The flow on its own, exactly as the designer exports it - which is what is
  // deployed, so this is the shape the pipeline really runs on.
  const bareExport = deployedExport;

  // The generator says what it read off the instance, which belongs in the lambda's
  // log rather than in this suite's output.
  let logged: jest.SpyInstance;
  beforeAll(() => {
    logged = jest.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => {
    logged.mockRestore();
  });

  function instanceLookups(
    calls: string[] = [],
    available: Record<string, unknown> = {
      [MODULE_ID]: popiaModule,
      [QUEUE_FLOW_ID]: queueFlow,
      [SALES_QUEUE_FLOW_ID]: salesQueueFlow,
      [TRANSFER_TARGET_ID]: transferTargetFlow,
    }
  ): ConnectLookups {
    return {
      async queueIdForName() {
        return undefined;
      },
      async hoursOfOperationIdForName() {
        return undefined;
      },
      async hoursOfOperationIdForQueue() {
        return undefined;
      },
      async customerQueueFlowIdForName(name) {
        calls.push(`ListContactFlows(${name})`);
        return name === QUEUE_FLOW_NAME ? QUEUE_FLOW_ID : undefined;
      },
      async contactFlowDefinition(id) {
        calls.push(`DescribeContactFlow(${id})`);
        return available[id];
      },
      async contactFlowModuleDefinition(id) {
        calls.push(`DescribeContactFlowModule(${id})`);
        return available[id];
      },
    };
  }

  it('finds what a bare export names but does not carry', () => {
    // Order follows the export's Actions array, which the designer rewrites
    // whenever the flow is edited, so it is the set that matters.
    const found = unresolvedFlowReferences(bareExport);

    expect(found).toHaveLength(4);
    expect(found).toEqual(
      expect.arrayContaining([
        { kind: 'module', reference: `${MODULE_ID}:$LATEST` },
        { kind: 'flow', reference: expect.stringContaining(`contact-flow/${QUEUE_FLOW_ID}`) },
        { kind: 'flow', reference: expect.stringContaining(`contact-flow/${SALES_QUEUE_FLOW_ID}`) },
        { kind: 'flow', reference: expect.stringContaining(`contact-flow/${TRANSFER_TARGET_ID}`) },
      ])
    );
  });

  it('asks for each resource once however many blocks name it', () => {
    // Three of the four event hook blocks in this flow set the same customer queue
    // flow; only the sales one sets the other.
    const hookBlocks = bareExport.Actions.filter(
      (action: any) => action.Type === 'UpdateContactEventHooks'
    );

    expect(hookBlocks.length).toBeGreaterThan(2);
    // Two queue flows and the one the decommissioned branch transfers to.
    expect(unresolvedFlowReferences(bareExport).filter((ref) => ref.kind === 'flow')).toHaveLength(3);
  });

  it('finds nothing to read when the definition already carries it', () => {
    expect(unresolvedFlowReferences(bundle)).toEqual([]);
  });

  it('has nothing to read off the instance for a menu tree, which names no flows', () => {
    expect(unresolvedFlowReferences({ menus: { main: { prompt: 'Press one', options: {} } } })).toEqual(
      []
    );
  });

  it('generates the same test cases from a bare export as from the bundle', async () => {
    const calls: string[] = [];
    const warnings: string[] = [];
    const fromExport = await generateTestCasesWithConnect(
      bareExport,
      {
        flowName: 'BM-Test-IaC-Flow',
        defaults: DEFAULTS,
        // The values file travels beside the export, not inside it.
        externalValues: declaredValues,
        warn: (m) => warnings.push(m),
      },
      instanceLookups(calls)
    );
    const bundleWarnings: string[] = [];
    const fromBundle = generateTestCases(bundle, {
      flowName: 'BM-Test-IaC-Flow',
      defaults: DEFAULTS,
      warn: (m) => bundleWarnings.push(m),
    });

    expect(fromExport).toEqual(fromBundle);
    // Nothing went wrong reading the pieces off the instance. What is left in the
    // report is the flow's own doing - the live Lambda failure branch, the branch
    // taken when no reference number is declared, and the queue the sales branch
    // sets but never transfers to.
    expect(warnings.join('\n')).not.toContain('not in the bundle');
    expect([...new Set(otherWarnings(warnings))]).toHaveLength(3);
    // The same flow either way round, so the same branches go uncovered and the
    // same report comes out - reading the pieces off the instance changes neither.
    expect(bundleWarnings).toEqual(warnings);
    // One call each, in whatever order the export lists the blocks that name them.
    expect(calls.sort()).toEqual([
      `DescribeContactFlow(${SALES_QUEUE_FLOW_ID})`,
      `DescribeContactFlow(${QUEUE_FLOW_ID})`,
      `DescribeContactFlow(${TRANSFER_TARGET_ID})`,
      `DescribeContactFlowModule(${MODULE_ID})`,
    ]);
  });

  it('puts the module prompt and the hold message into those test cases', async () => {
    const items = await generateTestCasesWithConnect(
      bareExport,
      {
        flowName: 'BM-Test-IaC-Flow',
        defaults: DEFAULTS,
        externalValues: declaredValues,
        warn: () => {},
      },
      instanceLookups()
    );
    const cases = Object.values(items);

    // The consent announcement is in the module, on every path that reaches it.
    const withPopia = cases.filter((item) =>
      messages(item).some((m) => m.includes('Protection of Personal Information Act'))
    );
    expect(withPopia.length).toBeGreaterThan(0);

    // The hold message is in the queue flow, on every path that reaches a queue.
    // Only the default queue flow is ever reached: the branch that sets the sales
    // one ends the flow instead of transferring, which the report says.
    const holdMessage =
      'Thank you for calling. Your call is very important to us and will be answered in the order it was received.';
    const queueing = cases.filter((item) => endsAtQueue(item));
    expect(queueing.length).toBeGreaterThan(0);
    for (const item of queueing) {
      // Last thing heard, then the transfer: the queue flow plays it on the way in.
      expect(blockNames(item).at(-1)).toBe('queue_message_1');
      // Read off the instance rather than carried in the bundle: this text is only
      // here if DescribeContactFlow was called and its prompts were walked.
      expect(messages(item).at(-1)).toBe(holdMessage);
    }
  });

  it('leaves the definition alone when there is nothing to read', async () => {
    const calls: string[] = [];
    await generateTestCasesWithConnect(
      bundle,
      { flowName: 'BM-Test-IaC-Flow', defaults: DEFAULTS, warn: () => {} },
      instanceLookups(calls)
    );

    expect(calls).toEqual([]);
  });

  it('keeps the copy the author bundled by hand, which may be about to be published', async () => {
    const edited = JSON.parse(JSON.stringify(popiaModule));
    edited.Actions.find((action: any) => action.Type === 'MessageParticipant').Parameters.Text =
      'A consent notice that is not published yet.';

    const calls: string[] = [];
    const items = await generateTestCasesWithConnect(
      { flow: bareExport, modules: { [MODULE_ID]: edited } },
      { flowName: 'BM-Test-IaC-Flow', defaults: DEFAULTS, externalValues: declaredValues, warn: () => {} },
      instanceLookups(calls)
    );

    const spoken = Object.values(items).flatMap((item) => messages(item));
    expect(spoken).toContain('A consent notice that is not published yet.');
    expect(spoken.some((m) => m.includes('POPIA'))).toBe(false);
    // Only the flows were still missing - the two queue flows and the one the
    // decommissioned branch transfers into.
    expect(calls.sort()).toEqual([
      `DescribeContactFlow(${SALES_QUEUE_FLOW_ID})`,
      `DescribeContactFlow(${QUEUE_FLOW_ID})`,
      `DescribeContactFlow(${TRANSFER_TARGET_ID})`,
    ]);
  });

  it('warns and carries on when a reference cannot be read off the instance', async () => {
    const warnings: string[] = [];
    const items = await generateTestCasesWithConnect(
      bareExport,
      {
        flowName: 'BM-Test-IaC-Flow',
        defaults: DEFAULTS,
        externalValues: declaredValues,
        warn: (m) => warnings.push(m),
      },
      // A module and a flow that were deleted, or that this role cannot read.
      instanceLookups([], {})
    );

    expect(warnings.join('\n')).toContain('invokes a module that is not in the bundle');
    expect(warnings.join('\n')).toContain('sets a customer queue flow that is not in the bundle');
    expect(Object.keys(items).length).toBeGreaterThan(0);
    expect(Object.values(items).flatMap((item) => messages(item)).some((m) => m.includes('POPIA'))).toBe(
      false
    );
  });

  it('follows a module that invokes another module', async () => {
    const inner = {
      Version: '2019-10-30',
      StartAction: 'inner-message',
      Metadata: { ActionMetadata: {} },
      Actions: [
        {
          Identifier: 'inner-message',
          Type: 'MessageParticipant',
          Parameters: { Text: 'Spoken by the inner module.' },
          Transitions: { NextAction: 'inner-end' },
        },
        { Identifier: 'inner-end', Type: 'EndFlowModuleExecution', Parameters: {}, Transitions: {} },
      ],
    };
    const outer = {
      Version: '2019-10-30',
      StartAction: 'invoke-inner',
      Metadata: { ActionMetadata: {} },
      Actions: [
        {
          Identifier: 'invoke-inner',
          Type: 'InvokeFlowModule',
          Parameters: { FlowModuleId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:$LATEST' },
          Transitions: { NextAction: 'outer-end' },
        },
        { Identifier: 'outer-end', Type: 'EndFlowModuleExecution', Parameters: {}, Transitions: {} },
      ],
    };
    const flow = {
      Version: '2019-10-30',
      StartAction: 'welcome',
      Metadata: { ActionMetadata: {} },
      Actions: [
        {
          Identifier: 'welcome',
          Type: 'MessageParticipant',
          Parameters: { Text: 'Welcome' },
          Transitions: { NextAction: 'invoke-outer' },
        },
        {
          Identifier: 'invoke-outer',
          Type: 'InvokeFlowModule',
          Parameters: { FlowModuleId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:$LATEST' },
          Transitions: { NextAction: 'goodbye' },
        },
        {
          Identifier: 'goodbye',
          Type: 'DisconnectParticipant',
          Parameters: {},
          Transitions: {},
        },
      ],
    };

    const calls: string[] = [];
    const items = await generateTestCasesWithConnect(
      flow,
      // Nothing in this flow checks the hours, so the definition has to supply them.
      {
        flowName: 'Nested-Module-Flow',
        defaults: { ...DEFAULTS, hours_of_operation: '44444444-4444-4444-4444-444444444444' },
        warn: () => {},
      },
      instanceLookups(calls, {
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa': outer,
        'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb': inner,
      })
    );

    // The inner module is only discoverable once the outer one has been read.
    expect(calls).toEqual([
      'DescribeContactFlowModule(aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa)',
      'DescribeContactFlowModule(bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb)',
    ]);
    // No menu, so there is one path through the flow.
    expect(Object.keys(items)).toEqual(['main']);
    expect(messages(items['main'])).toEqual(['Welcome', 'Spoken by the inner module.']);
  });

  // An export written before the flow set its CustomerQueue event hook - or a flow
  // that never sets one, which is the ordinary case - names no queue flow at all.
  // The caller still hears the instance's default customer queue flow, so a test
  // case that asserted nothing on hold would be asserting less than the flow does.
  describe('a flow that sets no customer queue flow of its own', () => {
    // The same export with the hook's CustomerQueue parameter taken off every
    // block that sets it: the flow still queues, it just no longer says where the
    // caller waits.
    const withoutQueueHook = () => {
      const flow = JSON.parse(JSON.stringify(bareExport));
      for (const action of flow.Actions) {
        if (action.Type === 'UpdateContactEventHooks') {
          delete action.Parameters?.EventHooks?.CustomerQueue;
        }
      }
      return flow;
    };

    // Nothing under "flows": the queue flow has to come off the instance, by name.
    const generate = async (calls: string[] = [], warnings: string[] = []) =>
      generateTestCasesWithConnect(
        { flow: withoutQueueHook(), modules: { [MODULE_ID]: popiaModule } },
        {
          flowName: 'BM-Test-IaC-Flow',
          defaults: { ...DEFAULTS, customer_queue_flow: QUEUE_FLOW_NAME },
          externalValues: declaredValues,
          warn: (m) => warnings.push(m),
        },
        instanceLookups(calls)
      );

    it('reads the instance default by name and asserts its hold message', async () => {
      const calls: string[] = [];
      const warnings: string[] = [];
      const items = await generate(calls, warnings);

      // No queue flow reference left in the export, so the name is the only way in.
      // The one reference that remains is the flow the decommissioned branch
      // transfers into, which is not a queue flow at all.
      expect(
        unresolvedFlowReferences({ flow: withoutQueueHook() }).filter((ref) => ref.kind === 'flow')
      ).toEqual([
        { kind: 'flow', reference: expect.stringContaining(`contact-flow/${TRANSFER_TARGET_ID}`) },
      ]);
      expect(calls.sort()).toEqual([
        `DescribeContactFlow(${QUEUE_FLOW_ID})`,
        `DescribeContactFlow(${TRANSFER_TARGET_ID})`,
        `ListContactFlows(${QUEUE_FLOW_NAME})`,
      ]);
      // Nothing about a resource that could not be read: what is left is the flow's
      // own uncovered branches.
      expect(warnings.join('\n')).not.toContain('not in the bundle');
      expect(warnings.join('\n')).not.toContain('nothing could be read');
      expect([...new Set(otherWarnings(warnings))]).toHaveLength(2);

      const queueing = Object.values(items).filter((item) => endsAtQueue(item));
      expect(queueing.length).toBeGreaterThan(0);
      for (const item of queueing) {
        expect(blockNames(item).at(-1)).toBe('queue_message_1');
        expect(messages(item).at(-1)).toContain('will be answered in the order it was received');
      }
    });

    it('gives the timeout and no-match test cases the same hold message as the rest', async () => {
      // These are the paths that reach a queue only after the menu's loop is spent,
      // so they are the ones where a missing hold block is easiest to miss.
      const items = await generate();

      for (const option of ['Timeout', 'Default', '1.Timeout', '1.Default']) {
        expect(endsAtQueue(items[option])).toBe(true);
        expect(blockNames(items[option]).at(-1)).toBe('queue_message_1');
        expect(items[option].check_queue).toEqual({ next: 'queue_message_1' });
        expect(items[option].queue_message_1).toEqual({
          Observe: { message: expect.stringContaining('answered in the order it was received') },
        });
      }
      // And the same message the digit paths assert, rather than one of its own.
      expect(messages(items['Timeout']).at(-1)).toBe(messages(items['3']).at(-1));
    });

    it('says so when the instance has no flow by that name, and still generates', async () => {
      const warnings: string[] = [];
      const items = await generateTestCasesWithConnect(
        { flow: withoutQueueHook(), modules: { [MODULE_ID]: popiaModule } },
        {
          flowName: 'BM-Test-IaC-Flow',
          defaults: { ...DEFAULTS, customer_queue_flow: 'Renamed-Default-Queue-Flow' },
          externalValues: declaredValues,
          warn: (m) => warnings.push(m),
        },
        instanceLookups()
      );

      expect(warnings.join('\n')).toContain('Renamed-Default-Queue-Flow');
      expect(warnings.join('\n')).toContain('DEFAULT_CUSTOMER_QUEUE_FLOW');
      // The test cases are still worth having: they assert everything up to the
      // transfer, which is the flow's own doing.
      expect(warnings.join('\n')).toContain('reaches a queue but nothing could be read');
      expect(endsAtQueue(items['Timeout'])).toBe(true);
      expect(blockNames(items['Timeout']).at(-1)).toBe('prompt_9');
      expect(items['Timeout'].queue_message_1).toBeUndefined();
    });
  });
});
