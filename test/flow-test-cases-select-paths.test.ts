// Writing down the call a test case should make.
//
// BM-Test-IaC-Flow has 71 paths, and a run of all 71 is 71 calls placed against the
// instance. Writing down the two or three that matter is how that becomes two or
// three - and a path that is written down is followed rather than looked for: at every
// point the flow offers a choice, the path says which one to take. So what these tests
// are about is that a path builds the call it describes, that a step it leaves out gets
// the obvious answer and says so, that the value it names is the one in force at the
// block that reads it, and above all that the test case it builds is byte-for-byte the
// one a full run would have built. A path that quietly built a different call would be
// worse than no path at all.

jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3');
  const send = jest.fn();
  return { ...actual, S3Client: jest.fn(() => ({ send })), __send: send };
});

jest.mock('@aws-sdk/client-connect', () => {
  const actual = jest.requireActual('@aws-sdk/client-connect');
  const send = jest.fn();
  return { ...actual, ConnectClient: jest.fn(() => ({ send })), __send: send };
});

import * as fs from 'fs';
import * as path from 'path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { ListTestCasesCommand } from '@aws-sdk/client-connect';
import type { S3Event } from 'aws-lambda';

const INSTANCE_ID = '6e669f6f-3783-4c0e-ac76-4f531575015d';
const BUCKET = 'rsa-automated-test-cases-results';

process.env.INSTANCE_ID = INSTANCE_ID;
process.env.REGION = 'af-south-1';
process.env.DEFAULT_CALLER_NUMBER = '+1234567890';

const {
  asPathSelectors,
  generateTestCasesWithConnect,
  handler,
  utteranceKey,
} = require('../lambda/flow-test-cases-gen') as typeof import('../lambda/flow-test-cases-gen');

const { __send: s3Send } = jest.requireMock('@aws-sdk/client-s3') as { __send: jest.Mock };
const { __send: connectSend } = jest.requireMock('@aws-sdk/client-connect') as {
  __send: jest.Mock;
};

const def = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flow-definition', file), 'utf-8'));
const fixture = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', file), 'utf-8'));

// The generator says what it read and what it selected, which belongs in the
// lambda's log rather than in this suite's output.
let logged: jest.SpyInstance;
beforeAll(() => {
  logged = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterAll(() => {
  logged.mockRestore();
});

describe('following the path a values file writes down', () => {
  // The flow that is deployed, the values that are deployed beside it, and the
  // resources it names read off the instance the way the lambda reads them - so the
  // labels these tests select by are the labels a real run produces.
  const MODULE_ID = 'ac128e1d-2a40-4c2c-9cf1-4c11cd87a4cd';
  const QUEUE_FLOW_ID = '384ed7f5-f4ee-4e84-a33c-b4b5bcb72c4e';
  const SALES_QUEUE_FLOW_ID = '2ef41232-837d-4c60-bd48-ca3630b25531';
  const TRANSFER_TARGET_ID = 'a37b12da-3217-4e34-ac9a-20bee93059de';

  const available: Record<string, unknown> = {
    [MODULE_ID]: fixture('rsa-popiaAct.module.json'),
    [QUEUE_FLOW_ID]: fixture('default-customer-queue.flow.json'),
    [SALES_QUEUE_FLOW_ID]: fixture('rsa-default-cust-queue.flow.json'),
    [TRANSFER_TARGET_ID]: def('BM-Test-Voice-IaC-Flow.json'),
  };

  const lookups = {
    async queueIdForName() {
      return undefined;
    },
    async hoursOfOperationIdForName() {
      return undefined;
    },
    async hoursOfOperationIdForQueue() {
      return undefined;
    },
    async customerQueueFlowIdForName(name: string) {
      return name === 'Default customer queue' ? QUEUE_FLOW_ID : undefined;
    },
    async contactFlowDefinition(id: string) {
      return available[id];
    },
    async contactFlowModuleDefinition(id: string) {
      return available[id];
    },
  };

  // What a caller says at the voice menu of the flow this one transfers to. Nothing
  // in an export carries them; on the instance they come off the bot.
  const utterances = new Map(
    Object.entries({
      'bs-general': 'general enquiry',
      'bs-sales': 'sales',
      'bs-technical': 'technical support',
      'bs-technical-wifi': 'wifi',
      'bs-technical-laptop': 'laptop',
    }).map(([intent, said]) => [utteranceKey(undefined, intent), said])
  );

  const generate = async (
    paths?: string[],
    external?: Record<string, unknown>,
    journeys?: unknown
  ) => {
    const warnings: string[] = [];
    const items = await generateTestCasesWithConnect(
      def('BM-Test-IaC-Flow.json'),
      {
        flowName: 'BM-Test-IaC-Flow',
        defaults: { caller_number: '+1234567890', hours_of_operation_results: 'InHour' },
        externalValues: { ...def('BM-Test-IaC-Flow.values.json').external, ...(external ?? {}) },
        utterances,
        paths,
        journeys,
        warn: (message: string) => warnings.push(message),
      },
      lookups
    );
    return { items, labels: Object.keys(items), warnings };
  };

  // Every path the flow has, which is what a written path is one of. Generated once: it
  // is the same walk each time, and it is the expensive one.
  let all: { items: Record<string, any>; labels: string[]; warnings: string[] };
  beforeAll(async () => {
    all = await generate();
  });

  // A test case less its own name: a path that was followed is named after the line
  // that asked for it rather than after the branches it took, and everything else about
  // it - every prompt, every key pressed, the hours, the queue - has to be what a full
  // run built for the same call.
  const call = (item: any) => {
    const { description, 'testing-option': option, ...rest } = item ?? {};
    return rest;
  };

  // What the caller hears last, which is the shortest way to say which branch a call
  // took: every branch of this flow signs off differently.
  const lastMessage = (item: any) => {
    const blocks = Object.values(item ?? {}).filter(
      (value: any) => value && typeof value === 'object' && value.Observe?.message
    ) as any[];
    return blocks[blocks.length - 1]?.Observe?.message as string | undefined;
  };

  it('builds every path when nothing is written down', () => {
    expect(all.labels.length).toBeGreaterThan(60);
    expect(all.labels).toContain('1.1.dicommisioned-false.isInHoursEmergency-false');
    expect(all.labels).toContain('OutOfHour.dicommisioned-true');
  });

  // Pressing 2 at the main menu, typing a customer reference, pressing 1, and the auth
  // number the lookup answers with - in that order, which is the order the caller does
  // it in. The label of the same call puts the two flags last and the typed digits
  // nowhere: "2.1.AUTH123456.dicommisioned-false.isInHoursEmergency-false".
  const IN_ORDER = 'dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.AUTH123456';
  const NAMED = 'dicommisioned-false.isInHoursEmergency-false.2.ref-number.1.AUTH123456';
  const LABEL = '2.1.AUTH123456.dicommisioned-false.isInHoursEmergency-false';

  it('builds one test case, named after the path as it was written', async () => {
    const { items, labels } = await generate([IN_ORDER]);

    expect(labels).toEqual([NAMED]);
    expect(items[NAMED].description).toContain(`the declared path ${NAMED}`);
  });

  it('builds the very test case a full run would have built for that call', async () => {
    const { items } = await generate([IN_ORDER]);

    expect(all.labels).toContain(LABEL);
    expect(call(items[NAMED])).toEqual(call(all.items[LABEL]));
  });

  it('follows one call per line and nothing else', async () => {
    const { items, labels } = await generate([IN_ORDER, 'dicommisioned-true']);

    expect(labels).toEqual([NAMED, 'dicommisioned-true']);
    // A decommissioned number is transferred to the voice flow, where the caller says
    // the first thing that flow offers - which is the call a full run labels by it.
    expect(call(items['dicommisioned-true'])).toEqual(call(all.items['bs-general.dicommisioned-true']));
  });

  it('does not care about case, because a step is named whatever the flow called it', async () => {
    const { items, labels } = await generate(['2.timeout.1']);

    expect(labels).toEqual(['2.timeout.1']);
    // The timeout really was taken: nothing is typed at the block, and the confirm
    // prompt plays back the word the block leaves behind instead of a number.
    expect(JSON.stringify(items['2.timeout.1'])).toContain('"timeout_5"');
    expect(JSON.stringify(items['2.timeout.1'])).toContain('entered is Timeout');
  });

  it('presses the star and hash keys by the key the caller presses', async () => {
    const { items, labels } = await generate(['1.*']);

    expect(labels).toEqual(['1.star']);
    expect(JSON.stringify(items['1.star'])).toContain('"user_action":"*"');
  });

  describe('the steps a path leaves out', () => {
    // A path says what matters. Everything else is answered the obvious way - the first
    // option of a menu, the number that was declared at an input block, the value the
    // flow already knows at a check - and every one of those is said out loud, because
    // it is an assumption about a call somebody wrote down deliberately.
    it('takes the obvious answer and says which block it assumed what about', async () => {
      const { items, labels, warnings } = await generate(['2']);

      expect(labels).toEqual(['2']);
      const assumed = warnings.filter((message) => message.includes('says nothing about it'));
      expect(assumed.join('\n')).toContain('so it read $.Attributes.dicommisioned as "false"');
      expect(assumed.join('\n')).toContain('Write "dicommisioned-false" into the path');
      expect(assumed.join('\n')).toContain('so it types "24680"');
      expect(assumed.join('\n')).toContain('Write "{ref-number}" into the path');
      expect(assumed.join('\n')).toContain('so it presses 1');
      // And having pressed 2 and taken the obvious answer to everything after it, the
      // call is the same one the fully written path builds.
      expect(call(items['2'])).toEqual(call(all.items[LABEL]));
    });

    it('says nothing about the blocks the path does account for', async () => {
      const { warnings } = await generate([IN_ORDER]);

      const assumed = warnings.filter((message) => message.includes('says nothing about it'));
      expect(assumed.join('\n')).not.toContain('dicommisioned');
      expect(assumed.join('\n')).not.toContain('{ref-number}');
    });
  });

  // The point of writing the values down: a flow that checks a number against a list of
  // them has one test case per number, and the path says which of the list this call is
  // about. Nothing is mocked - the number is what the test case expects the real lookup
  // to answer with - so what is being chosen here is which branch is asserted.
  describe('the value a path names at a check block', () => {
    const AUTH_NUMBERS = { auth_number: ['24352', '24680', 'AUTH123456'] };

    it('puts that value in force, whichever of the declared ones it is', async () => {
      const said = new Map<string, string | undefined>();
      for (const auth of ['auth_number-24352', 'auth_number-24680', 'AUTH123456']) {
        const { items, labels } = await generate(
          [`dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.${auth}`],
          AUTH_NUMBERS
        );
        said.set(auth, lastMessage(items[labels[0]]));
      }

      // Three lines of "paths", three branches of the auth check, three sign-offs.
      expect(new Set(said.values()).size).toBe(3);
      expect(said.get('auth_number-24680')).toContain('Sales agent');
      expect(said.get('AUTH123456')).toContain('Thank you');
    });

    it('takes the value with or without the name of what read it in front', async () => {
      const [withName, alone] = await Promise.all(
        ['auth_number-24680', '24680'].map((auth) =>
          generate([`dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.${auth}`], AUTH_NUMBERS)
        )
      );

      expect(lastMessage(withName.items[withName.labels[0]])).toEqual(
        lastMessage(alone.items[alone.labels[0]])
      );
    });

    it('takes the value by the name that declares it, rather than repeating it', async () => {
      // "{auth_number}" inside the step is what "external" declares for auth_number,
      // which for a list is the first of it - so a path can name the declaration and a
      // change to the values file carries into every line that refers to it.
      const [referring, written] = await Promise.all(
        ['auth_number-{auth_number}', 'auth_number-24352'].map((auth) =>
          generate(
            [`dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.${auth}`],
            AUTH_NUMBERS
          )
        )
      );

      expect(referring.labels).toEqual([
        'dicommisioned-false.isInHoursEmergency-false.2.ref-number.1.auth_number-24352',
      ]);
      expect(call(referring.items[referring.labels[0]])).toEqual(
        call(written.items[written.labels[0]])
      );
    });

    it('takes the first of the declared list where the path names none of them', async () => {
      const { items, labels } = await generate(
        ['dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1'],
        AUTH_NUMBERS
      );
      const first = await generate(
        ['dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.auth_number-24352'],
        AUTH_NUMBERS
      );

      expect(lastMessage(items[labels[0]])).toEqual(lastMessage(first.items[first.labels[0]]));
    });
  });

  // A flow that reads two numbers off the caller has two steps that could each be "{}",
  // and counting dots to tell them apart is exactly what naming the steps was meant to
  // save anyone from. So a name in braces is the attribute a "Store customer input"
  // block fills - what the caller did - and never what a "Check contact attributes"
  // block read, which the flow decided and a path writes out.
  describe('a step named in braces', () => {
    it('is the stored input, by the name a declaration calls it', async () => {
      const { items } = await generate([IN_ORDER]);
      expect(JSON.stringify(items[NAMED])).toContain('"user_action":"24680"');
    });

    it('stands in for any value at all when it is nobody’s name', async () => {
      for (const wildcard of ['{}', '{anything}', '{custinput}', '{input}', '{digits}']) {
        const written = IN_ORDER.replace('{ref-number}', wildcard);
        const { items, labels } = await generate([written]);

        expect(labels).toHaveLength(1);
        expect(call(items[labels[0]])).toEqual(call(all.items[LABEL]));
      }
    });

    it('is never what a check block read, and says what to write instead', async () => {
      // A flow can check the attribute an input block just filled, and then two steps
      // of the call go by one name. Braces are the caller's own value, so this asks for
      // a step nothing offers - and "{ref-number}" goes on meaning the digits.
      await expect(
        generate(['dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.{auth_number}'])
      ).rejects.toThrow(/"\{auth_number\}" is what a "Check contact attributes" block read/);

      await expect(
        generate(['dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.{auth_number}'])
      ).rejects.toThrow(/writes that out as "auth_number-<value>"/);
    });

    it('says which names there are when it is nobody’s name and nobody’s wildcard', async () => {
      await expect(generate(['2.{reference}.1'])).rejects.toThrow(
        /Nothing the caller gave on this call is called "reference" - the ones that are: ref-number/
      );
    });

    it('is that step and not another, so the wrong name is followed nowhere', async () => {
      // The digits typed at the input block are the reference, never the auth number -
      // that one is answered further down the call.
      await expect(
        generate(['dicommisioned-false.isInHoursEmergency-false.2.{auth_number}.1.AUTH123456'])
      ).rejects.toThrow(/nothing asked for "\{auth_number\}"/);
    });
  });

  describe('a path the flow does not take', () => {
    it('fails naming the step nothing asked for, and the call it followed instead', async () => {
      await expect(generate(['2.1.timeout'])).rejects.toThrow(
        /The path "2\.1\.timeout" is not a path BM-Test-IaC-Flow takes: "2\.1" was followed/
      );
      // The steps the call really made, which is the path that should have been written.
      await expect(generate(['2.1.timeout'])).rejects.toThrow(
        /The call it followed instead went dicommisioned-false\.isInHoursEmergency-false\.2\.24680\.1\.AUTH123456/
      );
    });

    it('fails on the order, because a path is the order the call happens in', async () => {
      await expect(generate(['isInHoursEmergency-false.dicommisioned-false'])).rejects.toThrow(
        /nothing asked for "dicommisioned-false"/
      );
    });

    it('follows whole steps, never text inside one', async () => {
      // "auth_number-24680" is a step; "auth_number-2" is the start of one.
      await expect(generate(['auth_number-2'])).rejects.toThrow(
        /nothing asked for "auth_number-2"/
      );
    });

    it('builds every path again when the list of them is emptied', async () => {
      const { labels } = await generate([]);
      expect(labels.sort()).toEqual(all.labels.sort());
    });
  });

  // Ten paths through the same module are ten copies of its steps, and a module that
  // changes is then ten lines to edit. A journey is that stretch written down once under
  // a name, and a path that goes through it says the name.
  describe('a stretch of a call, written down once', () => {
    // Everything before the auth number: the flags, option 2, and the reference typed in.
    const JOURNEYS = { front: 'dicommisioned-false.isInHoursEmergency-false.2.{ref-number}' };

    it('follows the call the steps it stands for would have followed', async () => {
      const { items, labels } = await generate(['@front.1.AUTH123456'], undefined, JOURNEYS);

      expect(labels).toEqual(['front.1.AUTH123456']);
      expect(call(items['front.1.AUTH123456'])).toEqual(call(all.items[LABEL]));
    });

    it('is the same stretch in every path that names it', async () => {
      const journeys = { ...JOURNEYS, sales: '@front.1' };
      const { items, labels } = await generate(
        ['@front.1.AUTH123456', '@sales.AUTH123456', '@front.timeout'],
        undefined,
        journeys
      );

      expect(labels).toEqual(['front.1.AUTH123456', 'sales.AUTH123456', 'front.timeout']);
      // A journey built out of another journey is the same stretch either way.
      expect(call(items['sales.AUTH123456'])).toEqual(call(items['front.1.AUTH123456']));
      // And one line going somewhere else after it still goes there.
      expect(lastMessage(items['front.timeout'])).not.toEqual(
        lastMessage(items['front.1.AUTH123456'])
      );
    });

    it('may be written as a list of steps rather than one dotted line', async () => {
      const listed = await generate(
        ['@front.1.AUTH123456'],
        undefined,
        { front: ['dicommisioned-false', 'isInHoursEmergency-false', '2', '{ref-number}'] }
      );

      expect(call(listed.items['front.1.AUTH123456'])).toEqual(call(all.items[LABEL]));
    });

    it('names the test case after the journey, not after the steps it stands for', async () => {
      const { labels, items } = await generate(['@front.1.AUTH123456'], undefined, JOURNEYS);

      expect(labels[0]).toBe('front.1.AUTH123456');
      // The description is where the whole call is spelled out.
      expect(items[labels[0]].description).toContain('front.1.AUTH123456');
    });

    // Which means the name of a generated test case goes back into "paths" and follows
    // the same call - the "@" is only there to be explicit about what a step is.
    it('reads the name a test case ended up with as the journey again', async () => {
      const { items, labels, warnings } = await generate(
        ['front.1.AUTH123456'],
        undefined,
        JOURNEYS
      );

      expect(labels).toEqual(['front.1.AUTH123456']);
      expect(call(items['front.1.AUTH123456'])).toEqual(call(all.items[LABEL]));
      expect(warnings.join('\n')).toContain('reads the step "front" as the journey of that name');
    });

    it('says which journeys there are when a path names one nothing writes down', async () => {
      await expect(generate(['@middle.1'], undefined, JOURNEYS)).rejects.toThrow(
        /goes through the journey "middle" and nothing writes it down. The journeys this values file writes down: front\./
      );
    });

    it('says so when a path puts a journey inside a step', async () => {
      await expect(generate(['2.ref-number-@front'], undefined, JOURNEYS)).rejects.toThrow(
        /puts "@front" inside a step/
      );
    });

    it('refuses a journey that goes through itself, rather than following it forever', async () => {
      await expect(
        generate(['@front.1'], undefined, { front: '2.@middle', middle: '1.@front' })
      ).rejects.toThrow(/goes through itself \(front -> middle -> front\)/);
    });

    it('refuses a name a step could have, because a path could not tell them apart', async () => {
      await expect(generate(['@front.1'], undefined, { '2': '1.yes' })).rejects.toThrow(
        /"2" cannot name a journey/
      );
      await expect(generate(['@front.1'], undefined, { 'front.back': '1' })).rejects.toThrow(
        /"front.back" cannot name a journey/
      );
      await expect(generate(['@front.1'], undefined, { Timeout: '1' })).rejects.toThrow(
        /"Timeout" cannot name a journey/
      );
    });
  });
});

// A path that cannot be built is worth being told about when you asked for it, and
// is noise when you did not - the whole point of naming three paths is that the
// report is about those three.
describe('what a selection is told about the paths it left out', () => {
  const LAMBDA = 'arn:aws:lambda:af-south-1:111122223333:function:call-config';

  // Two of this flow's three paths end the call in silence, so two of them cannot
  // be built at all: a decommissioned number is hung up on, and so is a caller who
  // rings out of hours.
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
      {
        Identifier: 'hours',
        Type: 'CheckHoursOfOperation',
        Parameters: { HoursOfOperationId: 'hoo-open' },
        Transitions: {
          NextAction: 'welcome',
          Conditions: [
            { NextAction: 'stop', Condition: { Operator: 'Equals', Operands: ['False'] } },
          ],
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

  const { generateTestCases } = require('../lambda/flow-test-cases-gen') as {
    generateTestCases: Function;
  };

  const generate = (paths?: string[]) => {
    const warnings: string[] = [];
    const items = generateTestCases(
      { flow, defaults: { caller_number: '+27100000000', hours_of_operation_results: 'InHour' } },
      {
        flowName: 'Silent-Flow',
        externalValues: { dicommisioned: ['false', 'true'] },
        paths,
        warn: (message: string) => warnings.push(message),
      }
    );
    return { labels: Object.keys(items), warnings };
  };

  const skips = (warnings: string[]) => warnings.filter((m) => /^Path .* skipping/.test(m));

  it('reports both silent paths when nothing is selected', () => {
    const { labels, warnings } = generate();

    expect(labels).toEqual(['dicommisioned-false']);
    expect(skips(warnings)).toHaveLength(2);
  });

  it('says why a selected path could not be built', () => {
    const { labels, warnings } = generate(['OutOfHour']);

    expect(labels).toEqual([]);
    expect(skips(warnings)).toHaveLength(1);
    expect(warnings.join('\n')).toContain(
      'Path OutOfHour reaches EndFlowExecution without a prompt'
    );
  });

  it('says nothing about a silent path that was not selected', () => {
    const { warnings } = generate(['OutOfHour']);
    expect(warnings.join('\n')).not.toContain('Path dicommisioned-true');
  });
});

describe('reading the selection out of the values file', () => {
  // A menu tree rather than an export: this is about the sidecar being read and
  // handed to the generator, so the smallest flow that has paths to choose between
  // is the clearest one to choose them in.
  const HOURS_ID = '4605e369-1e6e-4f7b-9e02-2e8d5b6d4b58';
  const QUEUE_ID = '73e9d156-a62d-4471-9cbb-af126df78a1d';

  const menuTree = {
    defaults: { hours_of_operation: HOURS_ID },
    prompts: ['Welcome to the test flow'],
    start: 'main_menu',
    menus: {
      main_menu: {
        prompt: 'Press one for technical issues. Press two for Sales.',
        options: {
          '1': 'technical_menu',
          '2': `queue:${QUEUE_ID}`,
        },
      },
      technical_menu: {
        prompt: 'Press one for WiFi issues, press two for laptop issues.',
        options: {
          '1': { prompts: ['Sending you our WiFi guide.'], disconnect: true },
          '2': { prompts: ['Sending you our laptop guide.'], disconnect: true },
        },
      },
    },
  };

  let objects: Record<string, unknown>;
  let written: Record<string, Record<string, any>>;
  let warned: jest.SpyInstance;

  beforeEach(() => {
    objects = {};
    written = {};
    warned = jest.spyOn(console, 'warn').mockImplementation(() => {});

    s3Send.mockReset();
    s3Send.mockImplementation(async (command: any) => {
      if (command instanceof GetObjectCommand) {
        const key = command.input.Key as string;
        if (!(key in objects)) {
          const error: any = new Error(`no such key ${key}`);
          error.name = 'NoSuchKey';
          throw error;
        }
        const body = JSON.stringify(objects[key]);
        return { Body: (async function* () { yield Buffer.from(body); })() };
      }
      if (command instanceof PutObjectCommand) {
        written[command.input.Key as string] = JSON.parse(command.input.Body as string);
        return {};
      }
      throw new Error(`unexpected S3 command ${command.constructor.name}`);
    });

    connectSend.mockReset();
    connectSend.mockImplementation(async (command: any) => {
      if (command instanceof ListTestCasesCommand) return { TestCaseSummaryList: [] };
      throw new Error(`unexpected Connect command ${command.constructor.name}`);
    });
  });

  afterEach(() => {
    warned.mockRestore();
  });

  const uploadEvent = (key: string): S3Event =>
    ({
      Records: [
        { eventName: 'ObjectCreated:Put', s3: { bucket: { name: BUCKET }, object: { key } } },
      ],
    } as unknown as S3Event);

  const upload = async (values?: unknown) => {
    objects['flow-definition/Menu-Flow.json'] = menuTree;
    if (values) objects['flow-definition/Menu-Flow.values.json'] = values;

    const result = await handler(uploadEvent('flow-definition/Menu-Flow.json'), {
      functionName: 'test',
    } as any);
    return { result, config: written['test-case-data/Menu-Flow.json'] ?? {} };
  };

  it('generates every path with no values file at all', async () => {
    const { config } = await upload();
    expect(Object.keys(config).sort()).toEqual(['1.1', '1.2', '2']);
  });

  // Writing paths down is what narrows a flow to the calls that were asked for, so
  // saying nothing about them is asking for all of them - whether the key was never
  // there, was emptied out, or holds nothing worth reading.
  it('generates every path when the values file says nothing about paths', async () => {
    const nothingSaid = [
      { external: { customerType: 'gold' } },
      { external: { customerType: 'gold' }, paths: [] },
      { paths: '' },
      { paths: ['', '   '] },
    ];

    for (const values of nothingSaid) {
      const { config } = await upload(values);
      expect(Object.keys(config).sort()).toEqual(['1.1', '1.2', '2']);
    }
  });

  it('generates only the paths the values file names', async () => {
    const { result, config } = await upload({ paths: ['1.2', '2'] });

    expect(Object.keys(config).sort()).toEqual(['1.2', '2']);
    expect(result.test_cases_generated).toBe(2);
  });

  it('takes a selection on its own, with no declared values beside it', async () => {
    const { config } = await upload({ paths: '1.1' });
    expect(Object.keys(config)).toEqual(['1.1']);
  });

  it('does not mistake the selection for something a Lambda returned', async () => {
    const { config } = await upload({ paths: ['1'], external: { customerType: 'gold' } });

    expect(Object.keys(config).sort()).toEqual(['1.1', '1.2']);
    // A "$.External.paths" would have been declared as the string "1" - so no
    // prompt of the selected paths can have been built out of one.
    expect(JSON.stringify(config)).not.toContain('paths');
  });

  // A one-digit selection is a branch of every menu that has that digit, not only
  // of the first one - "2" is the second option of the main menu and the second
  // option of the technical menu alike. Narrowing it means naming more of the label.
  it('selects a digit wherever it is pressed', async () => {
    expect(Object.keys((await upload({ paths: ['2'] })).config).sort()).toEqual(['1.2', '2']);
    expect(Object.keys((await upload({ paths: ['1.2'] })).config)).toEqual(['1.2']);
  });

  it('regenerates when the selection changes', async () => {
    await upload({ paths: ['1.1'] });
    expect(Object.keys(written['test-case-data/Menu-Flow.json'])).toEqual(['1.1']);

    objects['flow-definition/Menu-Flow.values.json'] = { paths: ['1.2'] };
    await handler(uploadEvent('flow-definition/Menu-Flow.values.json'), {
      functionName: 'test',
    } as any);

    expect(Object.keys(written['test-case-data/Menu-Flow.json'])).toEqual(['1.2']);
  });

  // A journey is expanded before anything is walked, so it reaches a menu tree as well -
  // which picks its paths rather than following them, and picks the expanded one.
  it('expands the journeys the values file writes down', async () => {
    const { config } = await upload({ journeys: { technical: '1' }, paths: ['@technical.2'] });

    expect(Object.keys(config)).toEqual(['1.2']);
    // A "$.External.journeys" would have been declared as an object, not read as steps.
    expect(JSON.stringify(config)).not.toContain('journeys');
  });

  it('reads that section under any of the names it goes by', async () => {
    for (const section of ['journeys', 'journey', 'fragments', 'path_parts', 'parts']) {
      const { config } = await upload({ [section]: { technical: '1' }, paths: ['@technical.1'] });
      expect(Object.keys(config)).toEqual(['1.1']);
    }
  });

  it('fails the upload when a path names a journey the values file does not write down', async () => {
    await expect(upload({ journeys: { technical: '1' }, paths: ['@sales.1'] })).rejects.toThrow(
      /goes through the journey "sales" and nothing writes it down/
    );
  });

  it('fails the upload when the selection matches nothing, rather than writing an empty config', async () => {
    await expect(upload({ paths: ['9'] })).rejects.toThrow(/produced no test cases/);
    expect(written['test-case-data/Menu-Flow.json']).toBeUndefined();
  });

  // The definition is a Connect export, replaced whole every time the flow changes, so
  // a default written into it does not survive the next export. The values file is
  // hand-written and does survive, so what it says about the hours of operation - or
  // the number the call comes from - wins over the definition.
  describe('the defaults the values file writes down', () => {
    const OTHER_HOURS = '9d1f0c22-6f42-4a5e-8f0b-1c8f5c2a77b1';
    const items = (config: Record<string, Record<string, any>>) => Object.values(config);

    it('says which hours of operation every test case mocks', async () => {
      const { config } = await upload({ defaults: { hours_of_operation: OTHER_HOURS } });

      expect(Object.keys(config).sort()).toEqual(['1.1', '1.2', '2']);
      for (const item of items(config)) expect(item.hours_of_operation).toBe(OTHER_HOURS);
    });

    it('says it as an arn as readily as an id', async () => {
      const { config } = await upload({
        defaults: {
          hours_of_operation: `arn:aws:connect:af-south-1:687244881512:instance/i-1/operating-hours/${OTHER_HOURS}`,
        },
      });

      for (const item of items(config)) expect(item.hours_of_operation).toBe(OTHER_HOURS);
    });

    // This flow plays the same menu whether it is open or closed, so the closed run has
    // nothing of its own to test and the generator says so - which is the proof that it
    // was asked for at all. Nothing but the values file asked for it.
    it('says which results to mock it with, one run of the flow each', async () => {
      const { config } = await upload({
        defaults: { hours_of_operation_results: ['InHour', 'OutOfHour'] },
      });

      for (const item of items(config)) expect(item.hours_of_operation_results).toBe('InHour');
      expect(warned.mock.calls.join('\n')).toContain(
        'Nothing in this flow depends on being closed, so no "OutOfHour" test case was generated'
      );
    });

    it('says which number the call comes from', async () => {
      const { config } = await upload({ defaults: { caller_number: '+27110000123' } });
      for (const item of items(config)) expect(item.caller_number).toBe('+27110000123');
    });

    it('beats what the definition says, and leaves the rest of it alone', async () => {
      const straight = (await upload()).config;
      const { config } = await upload({ defaults: { hours_of_operation: OTHER_HOURS } });

      for (const label of Object.keys(straight)) {
        expect(config[label].hours_of_operation).toBe(OTHER_HOURS);
        expect(straight[label].hours_of_operation).toBe(HOURS_ID);
        expect({ ...config[label], hours_of_operation: HOURS_ID }).toEqual(straight[label]);
      }
    });

    it('is a default written on its own too, because nothing reads it out of $.External', async () => {
      const { config } = await upload({ hours_of_operation: OTHER_HOURS });

      for (const item of items(config)) expect(item.hours_of_operation).toBe(OTHER_HOURS);
      expect(JSON.stringify(config)).not.toContain('$.External.hours_of_operation');
      expect(warned.mock.calls.join('\n')).toContain('outside "defaults"');
    });

    it('takes the section over the same default written on its own', async () => {
      const { config } = await upload({
        hours_of_operation: HOURS_ID,
        defaults: { hours_of_operation: OTHER_HOURS },
      });

      for (const item of items(config)) expect(item.hours_of_operation).toBe(OTHER_HOURS);
    });

    it('says so when it names something that is not a default', async () => {
      const { config } = await upload({
        defaults: { hours_of_operation: OTHER_HOURS, hours_of_opperation: 'RSA Business Hours' },
      });

      for (const item of items(config)) expect(item.hours_of_operation).toBe(OTHER_HOURS);
      expect(warned.mock.calls.join('\n')).toContain(
        '"defaults" names "hours_of_opperation", which is not a test case default'
      );
    });

    it('fails the upload when the defaults are not an object of them', async () => {
      await expect(upload({ defaults: 'InHour' })).rejects.toThrow(
        /"defaults" must hold an object of test case defaults/
      );
    });
  });
});

describe('asPathSelectors', () => {
  const parse = (raw: unknown) => {
    const warnings: string[] = [];
    return { selectors: asPathSelectors(raw, (m) => warnings.push(m)), warnings };
  };

  it('reads a list of labels', () => {
    expect(parse(['1.1', '2.Timeout']).selectors).toEqual(['1.1', '2.Timeout']);
  });

  it('reads a single label on its own', () => {
    expect(parse('2.Timeout').selectors).toEqual(['2.Timeout']);
  });

  it('reads a menu option that happens to be a number', () => {
    expect(parse(2).selectors).toEqual(['2']);
  });

  it('sanitises a label the same way the generator names one', () => {
    expect(parse(['1.*', '1.#', ' 2.Timeout ']).selectors).toEqual([
      '1.star',
      '1.hash',
      '2.Timeout',
    ]);
  });

  it('keeps the braces of a step it does not want to spell out', () => {
    expect(parse('2.{custinput}.1').selectors).toEqual(['2.{custinput}.1']);
  });

  it('means no selection when nothing is named', () => {
    expect(parse(undefined).selectors).toBeUndefined();
    expect(parse(null).selectors).toBeUndefined();
    expect(parse([]).selectors).toBeUndefined();
    expect(parse(['', '  ']).selectors).toBeUndefined();
  });

  it('says so when something that is not a label is named', () => {
    const { selectors, warnings } = parse(['1.1', { menu: '2' }]);

    expect(selectors).toEqual(['1.1']);
    expect(warnings.join('\n')).toContain('is not the name of a path');
  });
});
