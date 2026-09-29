import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  ConnectClient,
  ContactFlowType,
  DeleteTestCaseCommand,
  DescribeContactFlowCommand,
  DescribeContactFlowModuleCommand,
  DescribeQueueCommand,
  ListContactFlowsCommand,
  ListHoursOfOperationsCommand,
  ListQueuesCommand,
  ListTestCasesCommand,
  QueueType,
} from "@aws-sdk/client-connect";
import {
  LexModelsV2Client,
  DescribeBotAliasCommand,
  DescribeIntentCommand,
  ListBotLocalesCommand,
  ListIntentsCommand,
} from "@aws-sdk/client-lex-models-v2";
import type { S3Event, S3EventRecord, Context } from "aws-lambda";

const s3 = new S3Client({});
const connect = new ConnectClient({ region: process.env.REGION });

const FLOW_DEFINITION_PREFIX = process.env.FLOW_DEFINITION_PREFIX ?? "flow-definition/";
const TEST_CASE_DATA_PREFIX = process.env.TEST_CASE_DATA_PREFIX ?? "test-case-data/";

const MAX_TEST_CASES = Number(process.env.MAX_TEST_CASES ?? 200);
const MAX_MENU_DEPTH = Number(process.env.MAX_MENU_DEPTH ?? 10);

const INSTANCE_ID = process.env.INSTANCE_ID ?? "";

const LEX_LOCALE_ID = process.env.LEX_LOCALE_ID || "en_US";

const ENTRY_BLOCK_NAME = "welcome_message";
const QUEUE_TARGET_KEYWORD = "check_queue";
const QUEUE_MESSAGE_PREFIX = "queue_message_";

const DTMF_INPUT_TYPE = "DtmfInput";
const SPEECH_INPUT_TYPE = "Utterance";

const TIMEOUT_ERROR_TYPE = "InputTimeLimitExceeded";
const NO_MATCH_ERROR_TYPE = "NoMatchingCondition";

const NO_MATCH_DIGITS = ["9", "8", "7", "6", "0", "5", "4"];

const NO_MATCH_UTTERANCE =
  process.env.NO_MATCH_UTTERANCE || "something completely unrelated to any of these options";

const LOOP_TYPE = "Loop";
const CONTINUE_LOOPING = "continuelooping";
const DONE_LOOPING = "donelooping";

const MAX_LOOP_ITERATIONS = 10;

type MenuExit = "timeout" | "default";

const MENU_EXIT_LABELS: Record<MenuExit, string> = {
  timeout: "Timeout",
  default: "Default",
};

// What a caller does where the flow waits for input: type what it wants, type
// nothing at all, or type something it was not expecting. The last two are the
// timeout and default test cases, and neither of them types the number the flow
// wants - not even when the definition declares one.
type InputAttempt = "typed" | MenuExit;

// A call that includes no input leaves "Stored customer input" holding this, which
// the block's own documentation is explicit about: a timeout there is not an error
// branch, it carries on down Success with the words "Timeout" where the number
// should have been. A prompt reading the number back reads this back instead.
const TIMEOUT_STORED_INPUT = "Timeout";

const IN_HOUR = "InHour";
const OUT_OF_HOUR = "OutOfHour";

function isOutOfHour(hooResult: string): boolean {
  return hooResult.trim().toLowerCase().startsWith("out");
}

export interface Defaults {
  caller_number?: string;
  hours_of_operation?: string;
  hours_of_operation_results?: string;
  customer_queue_flow?: string;
  no_match_utterance?: string;
}

const DEFAULT_CUSTOMER_QUEUE_FLOW =
  process.env.DEFAULT_CUSTOMER_QUEUE_FLOW || "Default customer queue";

// The hours a test case mocks come out of the flow's own CheckHoursOfOperation
// block, or off the queue the branch targets. This is the last resort, for a flow
// that checks hours nowhere and queues nowhere the hours can be read from - a
// flow that only ever plays prompts, or one whose check lives in a module this
// instance will not hand over. Every test case still needs an hours id, because
// Connect mocks the check by resource, so without one there is nothing to
// generate at all. An id or a name; a name is resolved off the instance.
const ENV_DEFAULTS: Defaults = {
  caller_number: process.env.DEFAULT_CALLER_NUMBER || undefined,
  hours_of_operation: bareId(process.env.DEFAULT_HOURS_OF_OPERATION),
  customer_queue_flow: DEFAULT_CUSTOMER_QUEUE_FLOW,
};

export interface Step {
  message?: string;
  input?: string;
  inputType?: string;
  exit?: MenuExit;
}

/**
 * One decision, as the call made it: the value it turned on, and what that value
 * belongs to where the flow has a name for it - the attribute a check read, or the
 * attribute an input block stores its digits into. A menu key belongs to nothing;
 * pressing 2 is the whole of what happened.
 */
export interface TrailStep {
  value: string;
  name?: string;
  /**
   * Set on the steps the flow decided rather than the caller: what a "Check contact
   * attributes" block read. A flow that checks the attribute an input block just
   * filled has two steps of the same name, so they are told apart by who decided
   * them - braces are the caller's own value, and a check is written out.
   */
  kind?: "check";
}

export interface FlowPath {
  labels: string[];
  /**
   * What to call this path, where it was followed rather than found: the path as it was
   * written down. A path that was followed is not named after the branches it took -
   * the point of writing it is to say what the test case is - so this wins over the
   * label when there is one.
   */
  name?: string;
  /**
   * The decisions this path made, in the order the call made them: what each
   * "Check contact attributes" block saw, what the caller pressed or typed at each
   * menu and input block, which invocation was down. The label is not that order -
   * a declared value is appended to it after the walk and the hours result is
   * prepended - so this is what a path is selectable by in flow order.
   */
  trail?: TrailStep[];
  steps: Step[];
  queueId?: string;
  hooId?: string;
  hooQueueId?: string;
  hooResult?: string;
  walkedHoursCheck?: boolean;
  endsAtQueue: boolean;
  endedWith?: string;
  queueMessages?: string[];
  externalValues?: Record<string, string>;
  /** The invocation this path is about failing, if it is about one failing. */
  lambdaFailure?: LambdaFailure;
  usedExternalKeys?: string[];
  note: string;
}

interface GenerateOptions {
  flowName: string;
  /** The account-wide defaults, which anything the flow or the values file declares beats. */
  defaults?: Defaults;
  /** The "defaults" section of the values file, as it was written. */
  declaredDefaults?: unknown;
  maxTestCases?: number;
  maxMenuDepth?: number;
  utterances?: Utterances;
  externalValues?: ExternalValues;
  storedInputs?: StoredInputs;
  paths?: PathSelectors;
  /** The "journeys" section of the values file, as it was written. */
  journeys?: unknown;
  coverBranchValues?: boolean;
  warn?: (message: string) => void;
}

type TestCaseItem = Record<string, unknown>;

interface ConnectTransitionCondition {
  NextAction?: string;
  Condition?: { Operator?: string; Operands?: unknown[] };
}

interface ConnectAction {
  Identifier?: string;
  Type?: string;
  Parameters?: Record<string, any>;
  Transitions?: {
    NextAction?: string;
    Conditions?: ConnectTransitionCondition[];
    Errors?: { NextAction?: string; ErrorType?: string }[];
  };
}

export interface FlowDoc {
  key: string;
  name: string;
  startAction?: string;
  actions: Record<string, ConnectAction>;
  actionMetadata: Record<string, any>;
}

function asJsonObject(value: unknown, label: string): Record<string, any> {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch (e) {
      throw new Error(`${label} is a string but not valid JSON: ${(e as Error).message}`);
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed as Record<string, any>;
}

function bareId(value: unknown): string | undefined {
  let raw: unknown = value;
  if (typeof raw === "object" && raw !== null) {
    raw = (raw as Record<string, unknown>).Id ?? (raw as Record<string, unknown>).id;
  }
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const tail = trimmed.split("/").pop();
  if (!tail) return undefined;
  return tail.split(":")[0] || undefined;
}

const ATTRIBUTE_REFERENCE = /\$\.Attributes(?:\.([A-Za-z0-9_-]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;

const EXTERNAL_REFERENCE = /\$\.External(?:\.([A-Za-z0-9_-]+)|\[\s*['"]([^'"]+)['"]\s*\])/g;

// A contact has one customer input slot, not one per block: the last "Store
// customer input" block to run owns it and everything after reads it back as
// $.StoredCustomerInput. It is carried in the same map as the contact
// attributes, under a key no "Set contact attributes" block would write, so a
// prompt playing it, an attribute update copying it and a branch comparing it
// all resolve it with no further plumbing - and a branch of the walk inherits
// it, because cloning the state already clones that map.
const STORED_INPUT = "$.StoredCustomerInput";
const STORED_INPUT_KEY = "$StoredCustomerInput";
const STORED_INPUT_REFERENCE = /\$\.StoredCustomerInput/g;

function withKnownValues(
  text: string,
  attributes?: ReadonlyMap<string, string>,
  external?: ReadonlyMap<string, string>
): string {
  let filled = text;
  const stored = attributes?.get(STORED_INPUT_KEY);
  if (stored !== undefined && filled.includes(STORED_INPUT)) {
    filled = filled.replace(STORED_INPUT_REFERENCE, stored);
  }
  if (attributes && attributes.size > 0) {
    filled = filled.replace(
      ATTRIBUTE_REFERENCE,
      (reference, dotted, bracketed) => attributes.get(dotted ?? bracketed) ?? reference
    );
  }
  if (external && external.size > 0) {
    filled = filled.replace(
      EXTERNAL_REFERENCE,
      (reference, dotted, bracketed) => external.get(dotted ?? bracketed) ?? reference
    );
  }
  return filled;
}

function attributeReferences(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const names: string[] = [];
  for (const [, dotted, bracketed] of text.matchAll(ATTRIBUTE_REFERENCE)) {
    const name = dotted ?? bracketed;
    if (name) names.push(name);
  }
  return names;
}

function externalReferences(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const names: string[] = [];
  for (const [, dotted, bracketed] of text.matchAll(EXTERNAL_REFERENCE)) {
    const name = dotted ?? bracketed;
    if (name) names.push(name);
  }
  return names;
}

export function literalPromptText(
  raw: unknown,
  attributes?: ReadonlyMap<string, string>,
  external?: ReadonlyMap<string, string>
): string | undefined {
  if (typeof raw !== "string") return undefined;

  const withoutMarkup = withKnownValues(raw, attributes, external)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

  const literals = withoutMarkup
    .split(/\$\.[A-Za-z0-9_.\-\[\]'"]+|\$\{[^}]*\}/g)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

  if (literals.length === 0) return undefined;
  return literals.reduce((longest, part) => (part.length > longest.length ? part : longest));
}

const PROMPT_PARAMETERS = ["Text", "SSML", "PromptText"] as const;

function promptText(
  action: ConnectAction,
  attributes?: ReadonlyMap<string, string>,
  external?: ReadonlyMap<string, string>
): string | undefined {
  const parameters = action.Parameters ?? {};
  for (const name of PROMPT_PARAMETERS) {
    const text = literalPromptText(parameters[name], attributes, external);
    if (text) return text;
  }
  return undefined;
}

function unknownValueReferences(
  action: ConnectAction,
  attributes: ReadonlyMap<string, string>,
  external: ReadonlyMap<string, string>
): string[] {
  const parameters = action.Parameters ?? {};
  const missing = new Set<string>();

  for (const parameter of PROMPT_PARAMETERS) {
    const raw = parameters[parameter];
    if (typeof raw !== "string") continue;
    for (const [, dotted, bracketed] of raw.matchAll(ATTRIBUTE_REFERENCE)) {
      const name = dotted ?? bracketed;
      if (name && !attributes.has(name)) missing.add(`$.Attributes.${name}`);
    }
    for (const name of externalReferences(raw)) {
      if (!external.has(name)) missing.add(`$.External.${name}`);
    }
    if (raw.includes(STORED_INPUT) && !attributes.has(STORED_INPUT_KEY)) missing.add(STORED_INPUT);
  }

  return [...missing];
}

const DYNAMIC_VALUE_PATTERN = /\$\.|\$\{/;

const ATTRIBUTE_UPDATE_TYPE = "UpdateContactAttributes";

function literalAttributeUpdates(
  action: ConnectAction,
  attributes?: ReadonlyMap<string, string>,
  external?: ReadonlyMap<string, string>
): [string, string][] {
  const parameters = action.Parameters ?? {};

  const target = parameters.TargetContact;
  if (typeof target === "string" && target && target !== "Current") return [];

  const attributeMap = parameters.Attributes;
  if (typeof attributeMap !== "object" || attributeMap === null || Array.isArray(attributeMap)) {
    return [];
  }

  return Object.entries(attributeMap as Record<string, unknown>).flatMap(([name, value]) => {
    if (typeof value !== "string") return [];
    const filled = withKnownValues(value, attributes, external);
    return DYNAMIC_VALUE_PATTERN.test(filled) ? [] : [[name, filled] as [string, string]];
  });
}

export interface ExternalValues {
  [key: string]: string | string[];
}

const MAX_EXTERNAL_VARIANTS = Number(process.env.MAX_EXTERNAL_VARIANTS ?? 32);

const coversBranchValues = () => process.env.COVER_BRANCH_VALUES !== "false";

export interface ExternalVariant {
  labels: string[];
  values: Map<string, string>;
  fanned: string[];
}

const UNSET_VALUE = "";

function declaredValueList(
  key: string,
  raw: unknown,
  warn: (message: string) => void
): string[] {
  const values = (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
    if (typeof value === "string" && value.trim() !== "") return [value];
    if (typeof value === "boolean") return [String(value)];
    if (typeof value === "number" && Number.isFinite(value)) return [String(value)];
    if (value === null || value === "") return [UNSET_VALUE];
    warn(
      `Declared value for "${key}" is ${JSON.stringify(
        value ?? null
      )} - only text a prompt could play back or a branch could compare is usable, so it is ignored`
    );
    return [];
  });
  return [...new Set(values)];
}

function answerLabel(key: string, value: string): string {
  if (value === UNSET_VALUE) return `${key}-unset`;
  return /^(true|false)$/i.test(value) || /^-?\d+(\.\d+)?$/.test(value)
    ? `${key}-${value}`
    : value;
}

export function externalVariants(
  declared: ExternalValues | undefined,
  warn: (message: string) => void
): ExternalVariant[] {
  const single = new Map<string, string>();
  const fanned: [string, string[]][] = [];

  for (const [key, raw] of Object.entries(declared ?? {})) {
    const values = declaredValueList(key, raw, warn);
    if (values.length === 0) continue;
    if (values.length === 1) single.set(key, values[0]);
    else fanned.push([key, values]);
  }

  fanned.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const wanted = fanned.reduce((total, [, values]) => total * values.length, 1);
  if (wanted > MAX_EXTERNAL_VARIANTS) {
    const covered = eachValueOnce(single, fanned);
    warn(
      `The declared values combine into ${wanted} sets of Lambda answers, more than the ${MAX_EXTERNAL_VARIANTS} allowed - so rather than the first ${MAX_EXTERNAL_VARIANTS} combinations, ${covered.length} sets are walked that between them use every value once. Every branch a single value takes is still covered; one that needs two particular values together is not, and is named as uncovered below. Raise MAX_EXTERNAL_VARIANTS to walk every combination.`
    );
    return covered;
  }

  let variants: ExternalVariant[] = [{ labels: [], values: single, fanned: [] }];

  for (const [key, values] of fanned) {
    const grown: ExternalVariant[] = [];
    for (const variant of variants) {
      for (const value of values) {
        grown.push({
          labels: [...variant.labels, sanitizeLabel(answerLabel(key, value))],
          values: new Map([...variant.values, [key, value]]),
          fanned: [...variant.fanned, key],
        });
      }
    }
    if (grown.length === 0) continue;
    variants = grown;
  }

  return variants;
}

// Every declared value in a set of answers of its own: the first value of every key
// together, then each of the other values in turn against that baseline. This is
// what the cross product is cut down to when there is too much of it, and what it
// is cut down to matters - cutting the product off at the cap drops whole values of
// whichever key it fanned last, and the answer that takes a "no matching
// condition" branch is only ever one value of one key, so that branch is left
// uncovered along with it.
function eachValueOnce(
  single: Map<string, string>,
  fanned: [string, string[]][]
): ExternalVariant[] {
  const keys = fanned.map(([key]) => key);
  const baseline = new Map(single);
  for (const [key, values] of fanned) baseline.set(key, values[0]);

  const label = (answers: Map<string, string>) =>
    keys.map((key) => sanitizeLabel(answerLabel(key, answers.get(key) ?? UNSET_VALUE)));

  const variants: ExternalVariant[] = [
    { labels: label(baseline), values: baseline, fanned: keys },
  ];

  for (const [key, values] of fanned) {
    for (const value of values.slice(1)) {
      const answers = new Map(baseline);
      answers.set(key, value);
      variants.push({ labels: label(answers), values: answers, fanned: keys });
    }
  }

  return variants;
}

// A bundle's own root comes first, then the export nested under "flow" - so an
// export that carries its values inline keeps them when it is wrapped in a bundle
// to bring a module or a queue flow along with it.
const nestedFlow = (bundle: Record<string, any>): Record<string, any> => {
  const flow = bundle.flow;
  return typeof flow === "object" && flow !== null && !Array.isArray(flow) ? flow : {};
};

export function mergeExternalValues(
  bundle: Record<string, any>,
  sidecar: ExternalValues | undefined
): ExternalValues | undefined {
  const nested = nestedFlow(bundle);
  const inBundle =
    bundle.external ?? bundle.external_values ?? nested.external ?? nested.external_values;
  const fromBundle =
    typeof inBundle === "object" && inBundle !== null && !Array.isArray(inBundle)
      ? (inBundle as ExternalValues)
      : undefined;

  if (!fromBundle) return sidecar;
  if (!sidecar) return fromBundle;
  return { ...fromBundle, ...sidecar };
}

/**
 * What a caller types at a "Store customer input" block, read off the flow
 * definition. Keyed by the block's identifier, by the name of a contact
 * attribute the block's value is copied into, or "default" for every such block
 * in the flow. A bare string is the same as "default":
 *
 *   "stored_input": "0821234567"
 *   "stored_input": { "sales_number": "12345", "default": "1" }
 */
export interface StoredInputs {
  [nameOrId: string]: string;
}

export const STORED_INPUT_DEFAULT_KEY = "default";

// Keys are matched case-insensitively, because one of the forms they take is a
// block identifier copied out of an export.
function asStoredInputs(raw: unknown, warn: (m: string) => void): StoredInputs | undefined {
  if (typeof raw === "string" || typeof raw === "number") {
    const value = String(raw).trim();
    return value ? { [STORED_INPUT_DEFAULT_KEY]: value } : undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;

  const declared: StoredInputs = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string" || typeof value === "number") {
      const text = String(value).trim();
      if (text) declared[key.trim().toLowerCase()] = text;
      continue;
    }
    warn(
      `Declared customer input for "${key}" is ${JSON.stringify(
        value ?? null
      )} - only what a caller could actually type is usable, so it is ignored`
    );
  }
  return Object.keys(declared).length > 0 ? declared : undefined;
}

export function mergeStoredInputs(
  bundle: Record<string, any>,
  sidecar: StoredInputs | undefined,
  warn: (m: string) => void
): StoredInputs | undefined {
  const nested = nestedFlow(bundle);
  const fromBundle = asStoredInputs(
    bundle.stored_input ??
      bundle.stored_inputs ??
      (bundle.defaults ?? {}).stored_input ??
      nested.stored_input ??
      nested.stored_inputs,
    warn
  );

  if (!fromBundle) return sidecar;
  if (!sidecar) return fromBundle;
  return { ...fromBundle, ...sidecar };
}

/**
 * Which of a flow's paths to build a test case for, declared in
 * <FlowName>.values.json:
 *
 *   "paths": ["dicommisioned-false.isInHoursEmergency-false.2.{custinput}.1.AUTH123456"]
 *
 * A path can be named by its label, or - as above - by the decisions it makes in the
 * order the call makes them: each "Check contact attributes" block by the value it
 * saw, each menu by the key pressed, each "Store customer input" by what was typed,
 * with "{anything}" standing in for a value that is not worth writing out. The two
 * are not the same string, because a label is not chronological: a declared value is
 * appended to it after the walk, and the hours result is prepended.
 *
 * Every path a flow has is still walked - the selection decides what is written,
 * not what is explored, so a label is only ever the label it would have had.
 * Declaring nothing keeps all of them, which is what a flow with no selection
 * does.
 */
export type PathSelectors = string[];

// The sanitising a label goes through, less the braces a selector uses for the
// steps it does not want to spell out - so "1.*" finds the path the generator calls
// "1.star", and "{custinput}" survives to be matched as a wildcard. The "@" of a
// journey survives too, being the one other thing a path can say that is not a step.
function sanitizeSelector(selector: string): string {
  return selector
    .replace(/\*/g, "star")
    .replace(/#/g, "hash")
    .replace(/[^A-Za-z0-9._{}@-]/g, "_");
}

export function asPathSelectors(
  raw: unknown,
  warn: (m: string) => void
): PathSelectors | undefined {
  if (raw === undefined || raw === null) return undefined;

  const entries = Array.isArray(raw) ? raw : [raw];
  const selectors: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" || typeof entry === "number") {
      const selector = sanitizeSelector(String(entry).trim());
      if (selector) selectors.push(selector);
      continue;
    }
    warn(
      `Selected path ${JSON.stringify(
        entry ?? null
      )} is not the name of a path - a path is named by its label, like "2.Timeout", so this one is ignored`
    );
  }

  return selectors.length > 0 ? selectors : undefined;
}

// "{}", "{anything}", "{custinput}" - a step the selection knows happens and does
// not care about the value of. It stands in for a value the caller gave, which is why
// it does not stand in for a timeout or a no-match: those are the caller giving no
// value at all, and a selection that meant one of them says so by name. Nor does it
// stand in for what a "Check contact attributes" block read - the flow decided that,
// and a selection says which branch it took by writing the value out.
const WILDCARD_SEGMENT = /^\{([^{}]*)\}$/;

// The braced words that stand in for any value at all. Anything else in braces is
// read as the name of the thing that decided the step - "{ref-number}" - so a flow
// that stores two numbers can say which of them a step is, rather than counting
// dots. These are the words that are nobody's name.
const ANY_VALUE_WILDCARDS = new Set([
  "",
  "any",
  "anything",
  "value",
  "input",
  "custinput",
  "customerinput",
  "customer_input",
  "digits",
]);

const NOT_A_VALUE = new Set(Object.values(MENU_EXIT_LABELS).map((exit) => exit.toLowerCase()));

function segmentMatches(actual: TrailStep, wanted: string): boolean {
  const braced = WILDCARD_SEGMENT.exec(wanted);
  if (braced) {
    if (actual.kind === "check") return false;
    if (actual.value.length === 0 || NOT_A_VALUE.has(actual.value)) return false;
    const named = braced[1];
    return ANY_VALUE_WILDCARDS.has(named) || named === actual.name;
  }

  if (actual.value === wanted) return true;
  if (actual.name === undefined) return false;

  // A block that read a number or a true/false is named for both, "auth_number-24352",
  // and one that read anything else is named for the value alone, "AUTH123456". A
  // selection is written with the value either way - it is the value that says which
  // branch was meant - so the value on its own finds the block that read it.
  if (actual.value === `${actual.name}-${wanted}`) return true;

  // The step's own name, with no braces around it, which is how a followed test case
  // is named: "{ref-number}" is written into the name as "ref-number", so the name a
  // test case ends up with goes straight back into "paths" and follows the same call.
  // A check block is never named this way - the flow decided that step, and it goes in
  // as the value it read.
  if (actual.kind === "check" || actual.name !== wanted) return false;
  return actual.value.length > 0 && !NOT_A_VALUE.has(actual.value);
}

/**
 * A stretch of a call, written down once under a name.
 *
 * Ten paths that all walk through the same module are ten copies of the module's steps,
 * and a module that changes is then ten lines to find and edit. So the steps get a name -
 * `"journeys": { "popia": "1.yes" }` - and every path that walks them says `@popia` where
 * they go. Nothing about this is particular to a module: any stretch written more than
 * once can be named, and a journey may be built out of other journeys.
 *
 * A journey is expanded before the path is followed, so what gets followed is the whole
 * call, step by step, exactly as if it had been written out. The test case keeps the
 * short name.
 */
export type PathJourneys = Map<string, { name: string; steps: string }>;

// A journey goes where a step goes, so its name has to be one no step could be: not a
// menu option, not a dotted stretch of its own, and none of the words that are already
// steps - "Timeout", "Default", "InHour", or the braced words that mean any value at all.
const RESERVED_JOURNEY_NAMES = new Set([
  ...ANY_VALUE_WILDCARDS,
  ...NOT_A_VALUE,
  IN_HOUR.toLowerCase(),
  OUT_OF_HOUR.toLowerCase(),
]);

function journeySteps(value: unknown): string | undefined {
  const written = (Array.isArray(value) ? value : [value])
    .filter((part): part is string | number => typeof part === "string" || typeof part === "number")
    .map((part) => sanitizeSelector(String(part).trim()));

  const steps = written.join(".").split(".").filter(Boolean);
  return steps.length > 0 ? steps.join(".") : undefined;
}

export function asPathJourneys(raw: unknown, warn: (m: string) => void): PathJourneys | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      '"journeys" must hold an object of names to the steps they stand for - { "journeys": { "popia": "1.yes" } }'
    );
  }

  const journeys: PathJourneys = new Map();
  for (const [written, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = written.trim();
    const steps = journeySteps(value);
    if (steps === undefined) {
      warn(
        `The journey "${written}" stands for ${JSON.stringify(
          value ?? null
        )}, which is not a stretch of a call - a journey is written the way a path is, like "1.yes", so this one is ignored`
      );
      continue;
    }

    if (name.includes(".") || /^[0-9]+$/.test(name) || RESERVED_JOURNEY_NAMES.has(name.toLowerCase())) {
      throw new Error(
        `"${written}" cannot name a journey. A path says a journey where it would say a step, so the name has to be one no step could be: dots separate steps, a number on its own is a menu option, and "${[
          ...NOT_A_VALUE,
        ].join('", "')}" are steps in their own right.`
      );
    }

    for (const key of [name.toLowerCase(), sanitizeSelector(name).toLowerCase()]) {
      journeys.set(key, { name, steps });
    }
  }

  return journeys.size > 0 ? journeys : undefined;
}

// A journey built out of journeys is fine; one that goes through itself has no end.
const MAX_JOURNEY_DEPTH = 10;

/**
 * The paths as they will be followed: every journey a path names, written out in full.
 *
 * `@popia` is the explicit way to name one. The bare name works too - `popia` - which is
 * how a test case that went through a journey gets a name that goes straight back into
 * `paths`; it says so when it reads a step that way, since a step is what it looks like.
 */
function expandJourneys(
  selectors: PathSelectors,
  journeys: PathJourneys | undefined,
  warn: (m: string) => void
): PathSelectors {
  if (!selectors.some((selector) => selector.includes("@")) && !journeys) return selectors;

  const names = () => {
    const written = [...new Set([...(journeys?.values() ?? [])].map((journey) => journey.name))];
    return written.length > 0
      ? `The journeys this values file writes down: ${written.join(", ")}.`
      : "This values file writes down no journeys.";
  };

  const expand = (selector: string, segments: string[], through: string[]): string[] => {
    if (through.length > MAX_JOURNEY_DEPTH) {
      throw new Error(
        `The path "${selector}" goes through journeys more than ${MAX_JOURNEY_DEPTH} deep (${through.join(
          " -> "
        )}) - a journey that names itself, directly or through another, has no end.`
      );
    }

    const expanded: string[] = [];
    for (const segment of segments) {
      if (WILDCARD_SEGMENT.test(segment)) {
        expanded.push(segment);
        continue;
      }

      const at = segment.indexOf("@");
      if (at > 0) {
        throw new Error(
          `The path "${selector}" writes "${segment}", which puts "${segment.slice(
            at
          )}" inside a step. A journey stands for steps of its own, so it goes where a step goes: "${segment.slice(
            0,
            at
          )}.${segment.slice(at)}" is what that reads as.`
        );
      }

      const named = at === 0 ? segment.slice(1) : segment;
      const journey = journeys?.get(named.toLowerCase());
      if (!journey) {
        if (at === 0) {
          throw new Error(
            `The path "${selector}" goes through the journey "${named}" and nothing writes it down. ${names()} Write it down under "journeys", or write its steps into the path.`
          );
        }
        expanded.push(segment);
        continue;
      }

      if (through.some((seen) => seen.toLowerCase() === journey.name.toLowerCase())) {
        throw new Error(
          `The journey "${journey.name}" goes through itself (${[...through, journey.name].join(
            " -> "
          )}), so the path "${selector}" has no end.`
        );
      }

      if (at !== 0) {
        warn(
          `The path "${selector}" reads the step "${segment}" as the journey of that name, which is "${journey.steps}". Write it as "@${segment}" to say so plainly.`
        );
      }

      expanded.push(
        ...expand(selector, journey.steps.split(".").filter(Boolean), [...through, journey.name])
      );
    }

    return expanded;
  };

  return selectors.map((selector) =>
    expand(selector, selector.split(".").filter(Boolean), []).join(".")
  );
}

// What a followed test case is called: the path as it was written, less the punctuation
// that is about writing it - the braces of a step it did not spell out, the "@" of a
// journey. So the name is short, and pasting it back into "paths" follows the same call.
function pathName(selector: string): string {
  return selector.replace(/\{([^{}]*)\}/g, (_, inner: string) => inner || "value").replace(/@/g, "");
}

/**
 * A path that names a declared value instead of repeating it.
 *
 * `{ref-number}` inside a larger step - `ref-number-{ref-number}`, which is a check
 * block reading the number the caller typed - is the value the values file declares for
 * that name, filled in here. So the digits live in one place: change `stored_input` and
 * every line that checks them changes with it, rather than every line having to be
 * found and edited. A step that is nothing but braces is left alone, because that is
 * the other thing braces mean - the step whose value the path does not care about.
 */
function resolveDeclaredReferences(
  selectors: PathSelectors,
  storedInputs: Record<string, string> | undefined,
  external: ExternalValues | undefined,
  warn: (m: string) => void
): PathSelectors {
  const declared = new Map<string, string>();
  const describedNames = new Map<string, string>();
  const declare = (name: string, value: unknown, kind: string) => {
    if (value === undefined || value === null) return;
    const single = Array.isArray(value) ? value[0] : value;
    if (single === undefined || single === null) return;
    for (const key of [name.trim().toLowerCase(), sanitizeSelector(name.trim()).toLowerCase()]) {
      declared.set(key, String(single));
    }
    describedNames.set(name.trim().toLowerCase(), `${name} (${kind})`);
  };

  // A key with a list of values declares the first of them, which is the one a path
  // that says nothing else about it gets - so "{auth_number}" and a path naming no
  // value at that block are the same call.
  for (const [name, value] of Object.entries(external ?? {})) declare(name, value, "Lambda answer");
  // Last, so a name that is both a customer input and a Lambda answer is the input:
  // that is what a reference inside a step is for.
  for (const [name, value] of Object.entries(storedInputs ?? {})) {
    declare(name, value, "customer input");
  }

  const names = () =>
    describedNames.size > 0
      ? `The names this values file declares: ${[...describedNames.values()].join(", ")}.`
      : "This values file declares no values to refer to.";

  return selectors.map((selector) =>
    selector
      .split(".")
      .map((segment) => {
        if (WILDCARD_SEGMENT.test(segment)) return segment;
        return segment.replace(/\{([^{}]*)\}/g, (_, inner: string) => {
          const named = inner.trim();
          if (ANY_VALUE_WILDCARDS.has(named.toLowerCase())) {
            throw new Error(
              `The path "${selector}" writes "{${named}}" inside the step "${segment}", and "{${named}}" is a whole step of its own - the one whose value the path does not care about. A step that is part of a larger one is a value, so write the value, or the name of what declares it.`
            );
          }
          const value = declared.get(named.toLowerCase());
          if (value === undefined) {
            throw new Error(
              `The path "${selector}" refers to "{${named}}" and nothing declares ${named}. ${names()} Declare it, or write the value itself into the path.`
            );
          }
          warn(
            `The path "${selector}" reads "{${named}}" in the step "${segment}" as "${value}", which is what this values file declares for ${named}.`
          );
          return value;
        });
      })
      .join(".")
  );
}

// A label is the branches a path took joined by dots, and a trail is the decisions it
// made joined the same way. A selector matches on whole segments rather than on text,
// so "2.1" is the second option's first sub-option and never the "21" of some other
// label, and it matches anywhere in the run so a caller need not spell out the steps
// on either side of the part they care about.
function segmentsMatch(path: TrailStep[], selector: string[]): boolean {
  if (selector.length === 0 || selector.length > path.length) return false;
  for (let start = 0; start + selector.length <= path.length; start++) {
    if (selector.every((segment, index) => segmentMatches(path[start + index], segment))) return true;
  }
  return false;
}

interface PathSelection {
  wanted(label: string, trail?: TrailStep[]): string[];
  keep(selectors: string[]): void;
  unmatched(): string[];
}

function pathSelection(selectors: PathSelectors | undefined): PathSelection | undefined {
  if (!selectors || selectors.length === 0) return undefined;

  // Sanitised here as well as where a values file is read, so a selection reaches
  // the same paths however it arrives - "1.*" is the path the generator calls
  // "1.star" whether or not anything has tidied it up on the way in.
  const parsed = selectors.map((selector) => ({
    selector,
    segments: sanitizeSelector(selector).toLowerCase().split(".").filter(Boolean),
  }));
  const used = new Set<string>();

  return {
    // Either way of naming the path counts: the label the test case is called by, or
    // the order the call made its decisions in. Nothing has to say which was meant -
    // a run of segments that is one of them is hardly ever the other.
    wanted(label: string, trail?: TrailStep[]): string[] {
      const labelSegments = label
        .toLowerCase()
        .split(".")
        .map((value) => ({ value }));
      const trailSegments = (trail ?? []).map((step) => ({
        value: step.value.toLowerCase(),
        name: step.name?.toLowerCase(),
        kind: step.kind,
      }));
      return parsed
        .filter(
          (entry) =>
            segmentsMatch(labelSegments, entry.segments) ||
            segmentsMatch(trailSegments, entry.segments)
        )
        .map((entry) => entry.selector);
    },
    keep(matched: string[]): void {
      for (const selector of matched) used.add(selector);
    },
    unmatched(): string[] {
      return parsed.map((entry) => entry.selector).filter((selector) => !used.has(selector));
    },
  };
}

/**
 * A path being followed rather than looked for.
 *
 * A selection picks from the paths a flow has: every branch is walked, and the ones
 * whose name matches are written out. That holds while the walk and whoever wrote the
 * path agree about what the flow does, and stops holding the moment a flow has more
 * branches than the cap allows, or names a step differently from how the path spells
 * it - and then nothing is built and the labels have to be read to find out why.
 * Following is the other way round: at every point the flow offers a choice, the path
 * says which one to take. One path written down is one test case, built out of that
 * path alone, and a path the flow does not take says which step it parted company on.
 */
interface DirectedPath {
  /** The path as written, which is what the test case is named after. */
  selector: string;
  /** Its steps, sanitised and lowercased, in the order the call makes them. */
  segments: string[];
  /** How many of them have been taken. */
  cursor: number;
  /** The steps taken so far, for the report a path that cannot be followed gets. */
  taken: string[];
  /** The last block this path was asked anything about, for the same report. */
  askedAt?: string;
}

function directedPath(selector: string): DirectedPath {
  return {
    selector,
    segments: sanitizeSelector(selector).toLowerCase().split(".").filter(Boolean),
    cursor: 0,
    taken: [],
  };
}

/** The step this path names next, or nothing where every step of it has been taken. */
function wantedSegment(plan: DirectedPath): string | undefined {
  return plan.segments[plan.cursor];
}

function takeSegment(plan: DirectedPath, segment: string): void {
  plan.cursor += 1;
  plan.taken.push(segment);
}

// A step is read the same way whether the path is being followed or looked for, so
// "{ref-number}" is what the caller typed and "ref-number-24680" is what a check
// block read, either way.
function lowercased(step: TrailStep): TrailStep {
  return { value: step.value.toLowerCase(), name: step.name?.toLowerCase(), kind: step.kind };
}

/**
 * The one move a path names out of the moves a block offers, or nothing where it names
 * none of them. Naming none is ordinary: a path spells out the steps that matter and
 * leaves the rest to be assumed, and a step it names that this block does not offer
 * belongs to a block further down.
 */
function directedMove<T extends { step: TrailStep }>(
  plan: DirectedPath | undefined,
  moves: T[]
): T | undefined {
  if (!plan) return undefined;
  const wanted = wantedSegment(plan);
  if (wanted === undefined) return undefined;
  const found = moves.find((move) => segmentMatches(lowercased(move.step), wanted));
  if (found) takeSegment(plan, wanted);
  return found;
}

function comparisonOperands(action: ConnectAction): string[] {
  const values: string[] = [];
  for (const condition of action.Transitions?.Conditions ?? []) {
    for (const operand of condition.Condition?.Operands ?? []) {
      if (typeof operand === "string" || typeof operand === "number") values.push(String(operand));
    }
  }
  return values;
}

/**
 * Why a path could not be followed, said in a way that can be acted on: which of its
 * steps were followed and where to, which step nothing offered, and - above all - the
 * steps the call really made, which is the path that should have been written.
 */
function followingFailed(flowName: string, plan: DirectedPath, path: FlowPath | undefined): string {
  const remaining = plan.segments.slice(plan.cursor);
  const unfollowed = remaining[0] ?? "the rest of it";
  const followed =
    plan.taken.length > 0
      ? `"${plan.taken.join(".")}" was followed, as far as ${plan.askedAt ?? "the start of the flow"}`
      : "nothing on it was followed";
  const alsoUnasked =
    remaining.length > 1
      ? ` Nor for ${remaining
          .slice(1)
          .map((segment) => `"${segment}"`)
          .join(", ")}.`
      : "";

  const steps = path?.trail ?? [];
  const namesOf = (checks: boolean) =>
    new Map(
      steps
        .filter((step) => step.name !== undefined && (step.kind === "check") === checks)
        .map((step) => [(step.name as string).toLowerCase(), step.name as string])
    );

  const braced = WILDCARD_SEGMENT.exec(unfollowed)?.[1];
  const readByACheck = braced === undefined ? undefined : namesOf(true).get(braced);
  const typed = namesOf(false);

  const advice =
    readByACheck !== undefined
      ? `"${unfollowed}" is what a "Check contact attributes" block read, and a path writes that out as "${readByACheck}-<value>" - braces are only ever the value the caller gave.`
      : braced !== undefined && !ANY_VALUE_WILDCARDS.has(braced) && !typed.has(braced)
      ? `Nothing the caller gave on this call is called "${braced}"${
          typed.size > 0 ? ` - the ones that are: ${[...typed.values()].join(", ")}` : ""
        }.`
      : 'A path is the steps of one call in the order the call makes them: what the caller presses at each menu ("2"), what they type at an input block ("{ref-number}"), and what each "Check contact attributes" block read, written out as the value it read ("dicommisioned-false").';

  return (
    `The path "${plan.selector}" is not a path ${flowName} takes: ${followed}, and then nothing asked for "${unfollowed}".${alsoUnasked} ` +
    `The call it followed instead went ${
      steps.length > 0 ? steps.map((step) => step.value).join(".") : "nowhere"
    } and ${path ? `ended having ${path.note}` : "built nothing"}. ${advice}`
  );
}

function iterativeMessageTexts(
  action: ConnectAction,
  attributes?: ReadonlyMap<string, string>,
  external?: ReadonlyMap<string, string>
): string[] {
  const messages = (action.Parameters ?? {}).Messages;
  if (!Array.isArray(messages)) {
    const single = promptText(action, attributes, external);
    return single ? [single] : [];
  }
  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return undefined;
      const entry = message as Record<string, unknown>;
      return (
        literalPromptText(entry.Text, attributes, external) ??
        literalPromptText(entry.SSML, attributes, external)
      );
    })
    .filter((text): text is string => Boolean(text));
}

export function sanitizeLabel(label: string): string {
  return label
    .replace(/\*/g, "star")
    .replace(/#/g, "hash")
    .replace(/[^A-Za-z0-9._-]/g, "_");
}

function isDtmf(value: string): boolean {
  return /^[0-9*#]+$/.test(value);
}

function parseFlowDoc(key: string, name: string, raw: unknown): FlowDoc {
  const doc = asJsonObject(raw, `flow "${name}"`);
  const actionList: ConnectAction[] = Array.isArray(doc.Actions) ? doc.Actions : [];
  if (actionList.length === 0) {
    throw new Error(`flow "${name}" has no Actions`);
  }

  const actions: Record<string, ConnectAction> = {};
  for (const action of actionList) {
    if (action?.Identifier) actions[action.Identifier] = action;
  }

  const metadata = (doc.Metadata ?? {}) as Record<string, any>;
  const startAction =
    (typeof doc.StartAction === "string" && doc.StartAction) ||
    (typeof metadata.StartAction === "string" && metadata.StartAction) ||
    actionList[0]?.Identifier;

  return {
    key,
    name: typeof metadata.name === "string" && metadata.name ? metadata.name : name,
    startAction,
    actions,
    actionMetadata: (metadata.ActionMetadata ?? {}) as Record<string, any>,
  };
}

const DEPENDENCY_SECTIONS = ["modules", "flow_modules", "flows", "dependencies"] as const;
export interface ConnectBundle {
  main: FlowDoc;
  dependencies: Map<string, FlowDoc>;
}

function parseConnectBundle(bundle: Record<string, any>, flowName: string): ConnectBundle {
  const mainRaw = bundle.flow ?? bundle.main_flow ?? bundle.contact_flow ?? bundle.content ?? bundle;
  const main = parseFlowDoc("main", flowName, mainRaw);

  const dependencies = new Map<string, FlowDoc>();
  const index = (token: string | undefined, doc: FlowDoc) => {
    if (!token) return;
    const normalized = token.trim().toLowerCase();
    if (normalized && !dependencies.has(normalized)) dependencies.set(normalized, doc);
  };

  for (const source of DEPENDENCY_SECTIONS.map((section) => bundle[section])) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
    for (const [depKey, depRaw] of Object.entries(source as Record<string, unknown>)) {
      const doc = parseFlowDoc(`dep:${depKey}`, depKey, depRaw);
      index(depKey, doc);
      index(bareId(depKey), doc);
      index(doc.name, doc);
    }
  }

  return { main, dependencies };
}

function resolveDependency(
  bundle: ConnectBundle,
  reference: unknown,
  displayName: unknown
): FlowDoc | undefined {
  const candidates = [bareId(reference), typeof reference === "string" ? reference : undefined];
  if (typeof displayName === "string") candidates.push(displayName);

  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = bundle.dependencies.get(candidate.trim().toLowerCase());
    if (found) return found;
  }
  return undefined;
}

const METADATA_ALIASES: Record<string, string[]> = {
  ContactFlowId: ["contactFlow", "flow"],
  FlowModuleId: ["flowModule", "module"],
  QueueId: ["queue"],
  HoursOfOperationId: ["hoursOfOperation", "hours"],
};

function propertyIgnoringCase(source: unknown, name: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  const record = source as Record<string, unknown>;
  if (name in record) return record[name];
  const wanted = name.toLowerCase();
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === wanted) return record[key];
  }
  return undefined;
}

function metadataEntries(doc: FlowDoc, actionId: string, parameterName: string): any[] {
  const entry = doc.actionMetadata?.[actionId];
  if (!entry) return [];
  const parameters = propertyIgnoringCase(entry, "parameters");
  const candidates: unknown[] = [];
  for (const name of [parameterName, ...(METADATA_ALIASES[parameterName] ?? [])]) {
    candidates.push(propertyIgnoringCase(entry, name), propertyIgnoringCase(parameters, name));
  }
  return candidates.filter((candidate) => candidate && typeof candidate === "object");
}

function metadataDisplayName(doc: FlowDoc, actionId: string, parameterName: string): string | undefined {
  for (const entry of metadataEntries(doc, actionId, parameterName)) {
    const name = entry.text ?? entry.displayName ?? entry.name;
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

function eventHookDisplayName(doc: FlowDoc, actionId: string, hook: string): string | undefined {
  for (const entry of metadataEntries(doc, actionId, "EventHooks")) {
    const named = propertyIgnoringCase(entry, hook);
    if (!named || typeof named !== "object") continue;
    const name =
      propertyIgnoringCase(named, "displayName") ??
      propertyIgnoringCase(named, "text") ??
      propertyIgnoringCase(named, "name");
    if (typeof name === "string" && name) return name;
  }
  return undefined;
}

function metadataId(doc: FlowDoc, actionId: string, parameterName: string): string | undefined {
  for (const entry of metadataEntries(doc, actionId, parameterName)) {
    const id = bareId(entry.id ?? entry.Id ?? entry.arn ?? entry.Arn);
    if (id) return id;
  }
  return undefined;
}

export type Utterances = Map<string, string>;

export function utteranceKey(aliasArn: string | undefined, intentName: string): string {
  return `${(aliasArn ?? "").trim().toLowerCase()}#${intentName.trim().toLowerCase()}`;
}

function utteranceFor(
  utterances: Utterances | undefined,
  aliasArn: string | undefined,
  intentName: string
): string | undefined {
  if (!utterances) return undefined;
  return (
    utterances.get(utteranceKey(undefined, intentName)) ??
    utterances.get(utteranceKey(aliasArn, intentName))
  );
}

function lexAliasArn(action: ConnectAction): string | undefined {
  const raw = action.Parameters?.LexV2Bot?.AliasArn ?? action.Parameters?.LexBot?.AliasArn;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.startsWith("arn:") ? trimmed : undefined;
}

export interface LexBotReference {
  aliasArn: string;
  intents: string[];
}

export function lexBotReferences(parsed: unknown): LexBotReference[] {
  const bundle = asJsonObject(parsed, "flow definition");
  if (!looksLikeConnectExport(bundle)) return [];

  const connectBundle = parseConnectBundle(bundle, "flow");
  const byAlias = new Map<string, Set<string>>();

  for (const doc of new Set<FlowDoc>([connectBundle.main, ...connectBundle.dependencies.values()])) {
    for (const action of Object.values(doc.actions)) {
      if (!LEX_MENU_TYPES.has(action.Type ?? "")) continue;
      const aliasArn = lexAliasArn(action);
      if (!aliasArn) continue;
      const intents = byAlias.get(aliasArn) ?? new Set<string>();
      for (const branch of menuBranches(action)) intents.add(branch.value);
      byAlias.set(aliasArn, intents);
    }
  }

  return [...byAlias].map(([aliasArn, intents]) => ({ aliasArn, intents: [...intents] }));
}

export interface FlowReference {
  kind: "module" | "flow";
  reference: string;
}

export function unresolvedFlowReferences(parsed: unknown): FlowReference[] {
  const bundle = asJsonObject(parsed, "flow definition");
  if (!looksLikeConnectExport(bundle)) return [];

  const connectBundle = parseConnectBundle(bundle, "flow");
  const found = new Map<string, FlowReference>();

  const consider = (kind: FlowReference["kind"], raw: unknown, displayName: unknown) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    if (resolveDependency(connectBundle, raw, displayName)) return;
    const id = bareId(raw);
    if (!id) return;
    found.set(`${kind}:${id.toLowerCase()}`, { kind, reference: raw.trim() });
  };

  for (const doc of new Set<FlowDoc>([connectBundle.main, ...connectBundle.dependencies.values()])) {
    for (const [actionId, action] of Object.entries(doc.actions)) {
      switch (action.Type ?? "") {
        case MODULE_INVOCATION_TYPE:
          consider("module", moduleReference(action), metadataDisplayName(doc, actionId, "FlowModuleId"));
          break;
        case FLOW_TRANSFER_TYPE:
          consider("flow", flowTransferReference(action), metadataDisplayName(doc, actionId, "ContactFlowId"));
          break;
        case EVENT_HOOKS_TYPE:
          consider("flow", customerQueueReference(action), eventHookDisplayName(doc, actionId, "CustomerQueue"));
          break;
        default:
          break;
      }
    }
  }

  return [...found.values()];
}

const MAX_DEPENDENCY_ROUNDS = 10;

export async function resolveFlowDependencies(
  parsed: unknown,
  lookups: ConnectLookups,
  warn: (message: string) => void,
  customerQueueFlow?: string
): Promise<unknown> {
  const bundle = asJsonObject(parsed, "flow definition");
  if (!looksLikeConnectExport(bundle)) return parsed;

  const modules: Record<string, unknown> = {};
  const flows: Record<string, unknown> = {};
  const withResolved = (): Record<string, any> => ({
    ...bundle,
    ...(Object.keys(modules).length > 0
      ? { modules: { ...modules, ...(bundle.modules ?? {}) } }
      : {}),
    ...(Object.keys(flows).length > 0 ? { flows: { ...flows, ...(bundle.flows ?? {}) } } : {}),
  });

  for (let round = 0; round < MAX_DEPENDENCY_ROUNDS; round += 1) {
    const missing = unresolvedFlowReferences(withResolved());
    if (missing.length === 0) break;

    let resolved = 0;
    for (const { kind, reference } of missing) {
      const id = bareId(reference);
      if (!id) continue;
      const definition =
        kind === "module"
          ? await lookups.contactFlowModuleDefinition(id)
          : await lookups.contactFlowDefinition(id);
      if (definition === undefined) continue;
      (kind === "module" ? modules : flows)[id] = definition;
      resolved += 1;
    }

    if (resolved === 0) break;
    if (round === MAX_DEPENDENCY_ROUNDS - 1) {
      warn(
        `Stopped resolving flows and modules off the instance after ${MAX_DEPENDENCY_ROUNDS} rounds - the definition nests deeper than that, or refers back to itself`
      );
    }
  }

  const fallbackName = bundleDefaults(bundle).customer_queue_flow ?? customerQueueFlow;
  if (fallbackName && !resolveDependency(parseConnectBundle(withResolved(), "flow"), fallbackName, fallbackName)) {
    const id = await lookups.customerQueueFlowIdForName(fallbackName);
    if (!id) {
      warn(
        `No customer queue flow named "${fallbackName}" on this instance - a path that queues cannot assert what the caller hears on hold. Set DEFAULT_CUSTOMER_QUEUE_FLOW to the name this instance uses.`
      );
    } else {
      const definition = await lookups.contactFlowDefinition(id);
      if (definition !== undefined) flows[fallbackName] = definition;
    }
  }

  const names = [...Object.keys(modules), ...Object.keys(flows)];
  if (names.length === 0) return parsed;

  console.log(
    `Read ${names.length} flow(s)/module(s) off the Connect instance that the definition named but did not carry: ${names.join(", ")}`
  );
  return withResolved();
}

export function speakableUtterance(utterances: (string | undefined)[]): string | undefined {
  const cleaned = utterances
    .filter((utterance): utterance is string => typeof utterance === "string")
    .map((utterance) => utterance.trim())
    .filter((utterance) => utterance.length > 0);

  const literal = cleaned.find((utterance) => !utterance.includes("{"));
  if (literal) return literal;

  for (const utterance of cleaned) {
    const stripped = utterance.replace(/\{[^}]*\}/g, " ").replace(/\s+/g, " ").trim();
    if (stripped) return stripped;
  }
  return undefined;
}

export interface LexLookups {
  sampleUtterance(aliasArn: string, intentName: string): Promise<string | undefined>;
}

export function lexLookups(): LexLookups {
  const lex = new LexModelsV2Client({ region: process.env.REGION });

  interface BotContext {
    botId: string;
    botVersion: string;
    localeId: string;
    intentIds: Map<string, string>;
  }
  const contexts = new Map<string, Promise<BotContext | undefined>>();

  const loadContext = async (aliasArn: string): Promise<BotContext | undefined> => {
    const [botId, botAliasId] = aliasArn.split("bot-alias/").pop()?.split("/") ?? [];
    if (!botId || !botAliasId) {
      console.warn(`Cannot read a bot id and alias id out of "${aliasArn}"`);
      return undefined;
    }

    const alias = await lex.send(new DescribeBotAliasCommand({ botId, botAliasId }));
    const botVersion = alias.botVersion || "DRAFT";

    let localeId = Object.keys(alias.botAliasLocaleSettings ?? {})[0];
    if (!localeId) {
      const locales = await lex.send(new ListBotLocalesCommand({ botId, botVersion }));
      localeId = locales.botLocaleSummaries?.[0]?.localeId ?? LEX_LOCALE_ID;
    }

    const intentIds = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const page = await lex.send(
        new ListIntentsCommand({ botId, botVersion, localeId, nextToken })
      );
      for (const intent of page.intentSummaries ?? []) {
        if (intent.intentName && intent.intentId) {
          intentIds.set(intent.intentName.toLowerCase(), intent.intentId);
        }
      }
      nextToken = page.nextToken;
    } while (nextToken);

    return { botId, botVersion, localeId, intentIds };
  };

  return {
    async sampleUtterance(aliasArn, intentName) {
      let pending = contexts.get(aliasArn);
      if (!pending) {
        pending = loadContext(aliasArn).catch((e) => {
          console.warn(`Cannot read the Lex bot behind ${aliasArn}: ${(e as Error).message}`);
          return undefined;
        });
        contexts.set(aliasArn, pending);
      }

      const context = await pending;
      if (!context) return undefined;

      const intentId = context.intentIds.get(intentName.trim().toLowerCase());
      if (!intentId) return undefined;

      try {
        const described = await lex.send(
          new DescribeIntentCommand({
            intentId,
            botId: context.botId,
            botVersion: context.botVersion,
            localeId: context.localeId,
          })
        );
        return speakableUtterance((described.sampleUtterances ?? []).map((s) => s.utterance));
      } catch (e) {
        console.warn(`DescribeIntent failed for ${intentName}: ${(e as Error).message}`);
        return undefined;
      }
    },
  };
}

export async function resolveSpeechInputs(
  parsed: unknown,
  lookups: LexLookups,
  warn: (message: string) => void
): Promise<Utterances> {
  const resolved: Utterances = new Map();

  for (const { aliasArn, intents } of lexBotReferences(parsed)) {
    for (const intent of intents) {
      const utterance = await lookups.sampleUtterance(aliasArn, intent);
      if (!utterance) {
        warn(
          `No sample utterance for intent "${intent}" on ${aliasArn} - add one to the bot, or an "utterances" entry to the flow definition, so the test case knows what to say`
        );
        continue;
      }
      resolved.set(utteranceKey(aliasArn, intent), utterance);
    }
  }

  return resolved;
}

export function bundleUtterances(bundle: Record<string, any>): Utterances {
  const source = bundle.utterances ?? (bundle.defaults ?? {}).utterances;
  const resolved: Utterances = new Map();
  if (typeof source !== "object" || source === null || Array.isArray(source)) return resolved;

  for (const [intent, utterance] of Object.entries(source as Record<string, unknown>)) {
    if (typeof utterance === "string" && utterance.trim()) {
      resolved.set(utteranceKey(undefined, intent), utterance.trim());
    }
  }
  return resolved;
}

const DTMF_MENU_TYPES = new Set(["GetParticipantInput", "GetUserInput"]);
const LEX_MENU_TYPES = new Set(["ConnectParticipantWithLexBot"]);
const MENU_TYPES = new Set([...DTMF_MENU_TYPES, ...LEX_MENU_TYPES]);

type MenuKind = "dtmf" | "lex";

function menuKind(type: string): MenuKind {
  return LEX_MENU_TYPES.has(type) ? "lex" : "dtmf";
}

const MESSAGE_TYPES = new Set(["MessageParticipant", "PlayPrompt"]);
const ITERATIVE_MESSAGE_TYPE = "MessageParticipantIteratively";
const TERMINAL_TYPES = new Set([
  "DisconnectParticipant",
  "EndFlowExecution",
  "TransferContactToPhoneNumber",
  "TransferParticipantToThirdParty",
]);
const CONDITION_FIRST_TYPES = new Set([
  "Compare",
  "CheckContactAttributes",
  "CheckMetricData",
  "CheckStaffingGroupStatus",
]);

const LAMBDA_INVOCATION_TYPE = "InvokeLambdaFunction";
const WAIT_TYPE = "Wait";

function lambdaArn(action: ConnectAction): string | undefined {
  const parameters = action.Parameters ?? {};
  const arn =
    parameters.LambdaFunctionARN ?? parameters.LambdaFunctionArn ?? parameters.FunctionArn;
  return typeof arn === "string" && arn.trim() ? arn.trim() : undefined;
}

function comparisonReference(action: ConnectAction): string | undefined {
  const parameters = action.Parameters ?? {};
  const value = parameters.ComparisonValue ?? parameters.Value;
  if (typeof value === "string" && value.trim()) return value.trim();

  const attribute = parameters.Attribute ?? parameters.Key;
  return typeof attribute === "string" && attribute.trim()
    ? `$.Attributes.${attribute.trim()}`
    : undefined;
}

// What to call the thing a block compared, in a name a person would recognise:
// "$.Attributes.dicommisioned" is the dicommisioned check, "$.External.auth_number"
// is the auth_number one.
function referenceName(reference: string): string {
  const trimmed = reference
    .trim()
    .replace(/^\$\./, "")
    .replace(/^(Attributes|External|Customer|Contact)\./i, "");
  const last = trimmed.split(".").filter(Boolean).pop();
  return last ?? reference.trim();
}

function conditionHolds(
  condition: ConnectTransitionCondition | undefined,
  value: string
): boolean | undefined {
  const operator = condition?.Condition?.Operator;
  const operand = condition?.Condition?.Operands?.[0];
  if (typeof operator !== "string") return undefined;
  const other = typeof operand === "string" || typeof operand === "number" ? String(operand) : undefined;
  if (other === undefined) return undefined;

  if (value === "") return false;

  const asNumbers = (): [number, number] | undefined => {
    const left = Number(value);
    const right = Number(other);
    return Number.isFinite(left) && Number.isFinite(right) ? [left, right] : undefined;
  };
  const numeric = asNumbers();

  switch (operator) {
    case "Equals":
    case "TextEquals":
    case "NumberEquals":
      return numeric ? numeric[0] === numeric[1] : value === other;
    case "NumberGreaterThan":
      return numeric ? numeric[0] > numeric[1] : undefined;
    case "NumberGreaterOrEqualTo":
      return numeric ? numeric[0] >= numeric[1] : undefined;
    case "NumberLessThan":
      return numeric ? numeric[0] < numeric[1] : undefined;
    case "NumberLessOrEqualTo":
      return numeric ? numeric[0] <= numeric[1] : undefined;
    case "TextStartsWith":
      return value.startsWith(other);
    case "TextEndsWith":
      return value.endsWith(other);
    case "TextContains":
      return value.includes(other);
    default:
      return undefined;
  }
}

const MODULE_INVOCATION_TYPE = "InvokeFlowModule";
const FLOW_TRANSFER_TYPE = "TransferToFlow";
const EVENT_HOOKS_TYPE = "UpdateContactEventHooks";

function moduleReference(action: ConnectAction): unknown {
  return action.Parameters?.FlowModuleId ?? action.Parameters?.ModuleId;
}

function flowTransferReference(action: ConnectAction): unknown {
  return action.Parameters?.ContactFlowId ?? action.Parameters?.FlowId;
}

function customerQueueReference(action: ConnectAction): unknown {
  const hooks = action.Parameters?.EventHooks;
  if (!hooks || typeof hooks !== "object") return undefined;
  return (hooks as Record<string, unknown>).CustomerQueue;
}

function customerQueueMessages(
  doc: FlowDoc | undefined,
  attributes?: ReadonlyMap<string, string>,
  external?: ReadonlyMap<string, string>
): string[] | undefined {
  if (!doc) return undefined;

  const messages: string[] = [];
  const visited = new Set<string>();
  const known = new Map(attributes);
  let current = doc.startAction;

  while (current && !visited.has(current)) {
    visited.add(current);
    const action = doc.actions[current];
    if (!action) break;

    const type = action.Type ?? "";
    const transitions = action.Transitions ?? {};

    if (MESSAGE_TYPES.has(type)) {
      const message = promptText(action, known, external);
      if (message) messages.push(message);
      current = transitions.NextAction;
      continue;
    }

    if (type === ATTRIBUTE_UPDATE_TYPE) {
      for (const [name, value] of literalAttributeUpdates(action, known, external)) {
        known.set(name, value);
      }
      current = transitions.NextAction;
      continue;
    }

    if (type === ITERATIVE_MESSAGE_TYPE) {
      for (const message of iterativeMessageTexts(action, known, external)) messages.push(message);
      current = transitions.NextAction;
      continue;
    }

    if (TERMINAL_TYPES.has(type) || (transitions.Conditions ?? []).length > 0) break;
    current = transitions.NextAction;
  }

  return messages.length > 0 ? messages : undefined;
}

interface WalkState {
  labels: string[];
  /** What this path has decided so far, in the order it decided it. See FlowPath. */
  trail: TrailStep[];
  steps: Step[];
  queueId?: string;
  hooId?: string;
  hooQueueId?: string;
  checkedHours?: boolean;
  customerQueueFlow?: FlowDoc;
  attributes: Map<string, string>;
  external: Map<string, string>;
  usedExternal: Set<string>;
  attributeSource: Map<string, string[]>;
  visited: Set<string>;
  returnStack: { doc: FlowDoc; actionId?: string }[];
  loopCounts: Map<string, number>;
  menuChoice: Map<string, MenuExit>;
  /** What the caller did at an input block, so a loop back to it does the same again. */
  inputChoice: Map<string, InputAttempt>;
  /** What the caller pressed or said at a menu, so a loop back to it presses it again. */
  answeredMenus: Map<string, MenuBranch>;
  /** The invocations whose failure this path has already branched off, one branch each. */
  failedOnce: Set<string>;
  /** An asynchronous invocation this path has made and not yet waited for. */
  pendingAsyncLambda?: boolean;
  /** The function that invocation named, to name the test case for the wait it ends. */
  pendingAsyncArn?: string;
  /** The invocation this path is about failing, if it is about one failing. */
  lambdaFailure?: LambdaFailure;
  /** Where this path set the queue to transfer to, if it set one. */
  queueSetAt?: string;
  /** Whether this path named a customer queue flow, whether or not it was resolved. */
  setHoldFlow?: boolean;
}

/**
 * One of the things a caller can do at a block: the step it puts on the trail, what to
 * say about it in a warning, and what it does to a path that does it. Enumerating takes
 * every move, each into a copy of the state; following takes the one the path names.
 */
interface DirectedMove {
  step: TrailStep;
  /** What the test case does, said as a person would say it: "presses 2". */
  described: string;
  apply: (into: WalkState) => string | undefined;
}

function cloneState(state: WalkState): WalkState {
  return {
    labels: [...state.labels],
    trail: [...state.trail],
    steps: state.steps.map((step) => ({ ...step })),
    queueId: state.queueId,
    hooId: state.hooId,
    hooQueueId: state.hooQueueId,
    checkedHours: state.checkedHours,
    customerQueueFlow: state.customerQueueFlow,
    attributes: new Map(state.attributes),
    external: new Map(state.external),
    usedExternal: new Set(state.usedExternal),
    attributeSource: new Map(state.attributeSource),
    visited: new Set(state.visited),
    returnStack: state.returnStack.map((frame) => ({ ...frame })),
    loopCounts: new Map(state.loopCounts),
    menuChoice: new Map(state.menuChoice),
    inputChoice: new Map(state.inputChoice),
    answeredMenus: new Map(state.answeredMenus),
    failedOnce: new Set(state.failedOnce),
    pendingAsyncLambda: state.pendingAsyncLambda,
    pendingAsyncArn: state.pendingAsyncArn,
    lambdaFailure: state.lambdaFailure,
    queueSetAt: state.queueSetAt,
    setHoldFlow: state.setHoldFlow,
  };
}

function newWalkState(steps: Step[] = []): WalkState {
  return {
    labels: [],
    trail: [],
    steps,
    attributes: new Map(),
    external: new Map(),
    usedExternal: new Set(),
    attributeSource: new Map(),
    visited: new Set(),
    returnStack: [],
    loopCounts: new Map(),
    menuChoice: new Map(),
    inputChoice: new Map(),
    answeredMenus: new Map(),
    failedOnce: new Set(),
  };
}

function loopSignature(state: WalkState): string {
  if (state.loopCounts.size === 0) return "";
  return [...state.loopCounts]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, count]) => `${id}=${count}`)
    .join(",");
}

function menuExitTarget(
  action: ConnectAction,
  exit: MenuExit,
  kind: MenuKind
): string | undefined {
  const errors = action.Transitions?.Errors ?? [];
  const forType = (errorType: string) =>
    errors.find((error) => error.ErrorType === errorType)?.NextAction;

  if (exit === "default") {
    return forType(NO_MATCH_ERROR_TYPE) ?? (kind === "dtmf" ? action.Transitions?.NextAction : undefined);
  }
  return (
    forType(TIMEOUT_ERROR_TYPE) ??
    (kind === "dtmf" ? action.Transitions?.NextAction : forType(NO_MATCH_ERROR_TYPE))
  );
}

interface MenuInput {
  input: string;
  inputType: string;
}

interface MenuBranch extends Partial<MenuInput> {
  value: string;
  target?: string;
  inputType: string;
}

function menuBranchInput(
  value: string,
  kind: MenuKind,
  aliasArn: string | undefined,
  utterances: Utterances | undefined
): MenuInput | { input: undefined; inputType: string } {
  if (kind === "dtmf") {
    return { input: value, inputType: isDtmf(value) ? DTMF_INPUT_TYPE : SPEECH_INPUT_TYPE };
  }
  return { input: utteranceFor(utterances, aliasArn, value), inputType: SPEECH_INPUT_TYPE };
}

function noMatchInput(
  branches: MenuBranch[],
  kind: MenuKind,
  noMatchUtterance: string
): MenuInput | undefined {
  const offered = new Set(
    branches.flatMap((branch) => [branch.value, branch.input ?? ""]).map((v) => v.trim().toLowerCase())
  );

  if (kind === "lex") {
    const utterance = noMatchUtterance.trim();
    return utterance && !offered.has(utterance.toLowerCase())
      ? { input: utterance, inputType: SPEECH_INPUT_TYPE }
      : undefined;
  }

  const digit = NO_MATCH_DIGITS.find((digit) => !offered.has(digit));
  return digit ? { input: digit, inputType: DTMF_INPUT_TYPE } : undefined;
}

function menuExitStep(
  message: string | undefined,
  exit: MenuExit,
  noMatch: MenuInput | undefined
): Step {
  if (exit === "timeout") return { message, exit };
  return noMatch ? { message, ...noMatch, exit } : { message, exit };
}

function menuExitNote(exit: MenuExit): string {
  return exit === "timeout" ? "no input at the menu" : "input the menu does not offer";
}

function loopLimit(
  action: ConnectAction,
  flow: FlowDoc,
  actionId: string,
  warn: (m: string) => void
): number {
  const declared = Number(action.Parameters?.LoopCount);
  if (!Number.isFinite(declared) || declared < 0) {
    warn(
      `${flow.name} loop ${actionId} has no usable LoopCount - treating it as a single pass`
    );
    return 1;
  }
  if (declared > MAX_LOOP_ITERATIONS) {
    warn(
      `${flow.name} loop ${actionId} repeats ${declared} times - walking only ${MAX_LOOP_ITERATIONS} of them`
    );
    return MAX_LOOP_ITERATIONS;
  }
  return Math.floor(declared);
}

// The branch a block takes for a named outcome - the loop's "ContinueLooping", the
// wait's "LambdaReturned" - which is the operand the condition carries.
function conditionTarget(action: ConnectAction, operand: string): string | undefined {
  const wanted = operand.trim().toLowerCase();
  return (action.Transitions?.Conditions ?? []).find((condition) => {
    const value = condition.Condition?.Operands?.[0];
    return typeof value === "string" && value.trim().toLowerCase() === wanted;
  })?.NextAction;
}

function loopBranch(action: ConnectAction, wanted: string): string | undefined {
  return conditionTarget(action, wanted) ?? action.Transitions?.NextAction;
}

// An "Invoke Lambda" block set to Asynchronous does not wait for the answer: the
// contact carries on, and a "Wait" block further down is what waits for it.
function invokesAsynchronously(action: ConnectAction): boolean {
  const raw = action.Parameters?.InvocationType;
  return typeof raw === "string" && raw.trim().toLowerCase() === "asynchronous";
}

/**
 * Which branch of a "Wait" block an asynchronous Lambda takes when it answers.
 * The branch names are the flow author's own words - "LambdaReturned" is only what
 * the console fills in - so the branch is found by the event it listens for.
 */
function asyncLambdaWaitBranch(action: ConnectAction): string | undefined {
  const events = action.Parameters?.InterruptibleEvents;
  if (typeof events !== "object" || events === null || Array.isArray(events)) return undefined;

  for (const [name, event] of Object.entries(events as Record<string, unknown>)) {
    if (
      typeof event === "object" &&
      event !== null &&
      "AsyncLambdaCompletionEvent" in (event as Record<string, unknown>)
    ) {
      return name;
    }
  }
  return undefined;
}

// The branch a "Wait" block takes when nothing interrupted it - when the answer it
// was held open for never came.
const WAIT_COMPLETED = "WaitCompleted";

// Every block's "Error" branch is exported under this one error type, whatever the
// block and whatever went wrong there.
const NO_MATCHING_ERROR = "NoMatchingError";

/** The invocation a path is about failing, to name that test case after it. */
interface LambdaFailure {
  arn: string;
}

/** Where a block goes when what it tried to do failed: its "Error" branch. */
function errorTarget(action: ConnectAction): string | undefined {
  const errors = action.Transitions?.Errors ?? [];
  return (
    errors.find((error) => error.ErrorType === NO_MATCHING_ERROR)?.NextAction ??
    errors[0]?.NextAction
  );
}

/** The function's own name, to name a test case after the invocation that failed. */
function lambdaName(arn: string): string {
  const parts = arn.split(":");
  const at = parts.indexOf("function");
  return (at >= 0 ? parts[at + 1] : parts[parts.length - 1]) || arn;
}

function menuBranches(action: ConnectAction): { value: string; target?: string }[] {
  const branches: { value: string; target?: string }[] = [];
  const seen = new Set<string>();

  for (const condition of action.Transitions?.Conditions ?? []) {
    const operand = condition.Condition?.Operands?.[0];
    if (typeof operand !== "string" && typeof operand !== "number") continue;
    const value = String(operand).trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    branches.push({ value, target: condition.NextAction });
  }

  return branches;
}

function storesInput(action: ConnectAction): boolean {
  const raw = action.Parameters?.StoreInput;
  return raw === true || (typeof raw === "string" && raw.trim().toLowerCase() === "true");
}

// "Maximum digits" on the block, which is the one thing the flow itself says
// about the input it is waiting for.
function maximumStoredLength(action: ConnectAction): number | undefined {
  const validation = action.Parameters?.InputValidation;
  if (typeof validation !== "object" || validation === null) return undefined;
  const raw =
    (validation as Record<string, any>).CustomValidation?.MaximumLength ??
    (validation as Record<string, any>).MaximumLength;
  const length = Number(raw);
  return Number.isFinite(length) && length > 0 ? Math.floor(length) : undefined;
}

const STORED_INPUT_DIGITS = "1234";

const STORED_INPUT_LOOKAHEAD = 6;

// The names a declaration can call this block by: whichever contact attributes
// the input is copied into just after it, so the definition can say
// { "sales_number": "12345" } instead of quoting a block identifier. Only the
// straight run of blocks after it is read - the first branch ends the search,
// because past that point which attribute is set is no longer this block's story.
function storedInputNames(flow: FlowDoc, actionId: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>([actionId]);
  let current = flow.actions[actionId]?.Transitions?.NextAction;

  for (let hop = 0; hop < STORED_INPUT_LOOKAHEAD && current && !seen.has(current); hop++) {
    seen.add(current);
    const action = flow.actions[current];
    if (!action) break;

    const type = action.Type ?? "";
    if (TERMINAL_TYPES.has(type) || MENU_TYPES.has(type)) break;
    if ((action.Transitions?.Conditions ?? []).length > 0) break;

    if (type === ATTRIBUTE_UPDATE_TYPE) {
      const attributes = (action.Parameters ?? {}).Attributes;
      if (attributes && typeof attributes === "object") {
        for (const [name, value] of Object.entries(attributes as Record<string, unknown>)) {
          if (typeof value === "string" && value.includes(STORED_INPUT)) names.push(name);
        }
      }
    }

    current = action.Transitions?.NextAction;
  }

  return names;
}

interface StoredInputChoice {
  value: string;
  declared: boolean;
  /** What a declaration would call this block, for the warning that asks for one. */
  name: string;
}

function storedInputFor(
  flow: FlowDoc,
  actionId: string,
  action: ConnectAction,
  declared: StoredInputs | undefined
): StoredInputChoice {
  const names = storedInputNames(flow, actionId);

  for (const key of [actionId, ...names, STORED_INPUT_DEFAULT_KEY]) {
    const value = declared?.[key.trim().toLowerCase()];
    if (value) return { value, declared: true, name: names[0] ?? actionId };
  }

  // Nothing declared, so the test case types digits of its own. Unlike a Lambda
  // answer this is not a guess about someone else's system - the test case is
  // the caller, so whatever it types is what the flow really receives, and a
  // prompt playing it back can still be asserted word for word. What it cannot
  // know is whether these digits are the ones a later branch is looking for.
  const limit = maximumStoredLength(action);
  const value =
    limit !== undefined && limit < STORED_INPUT_DIGITS.length
      ? STORED_INPUT_DIGITS.slice(0, limit)
      : STORED_INPUT_DIGITS;

  return { value, declared: false, name: names[0] ?? actionId };
}

const WRONG_STORED_INPUT_LENGTH = 4;

// The number the flow was not asking for. Its digits are ones the wanted number
// does not use, so a later branch looking for the real one cannot match this by
// accident, and a prompt reading it back is still read back word for word.
function wrongStoredInput(wanted: string, limit: number | undefined): string {
  const digit = NO_MATCH_DIGITS.find((candidate) => !wanted.includes(candidate)) ?? "0";
  const width = Math.max(1, Math.min(WRONG_STORED_INPUT_LENGTH, limit ?? WRONG_STORED_INPUT_LENGTH));
  return digit.repeat(width);
}

interface InputAttemptPlan {
  attempt: InputAttempt;
  /** The step, less the prompt text the walker holds. */
  step: Step;
  /** What "Stored customer input" holds afterwards. */
  stored: string;
  target?: string;
}

// The three test cases an input block earns. Nothing is sent on the timeout one -
// that is what makes it a timeout - and the number sent on the default one is
// deliberately not the one the flow wants, however the definition declares it.
// Neither goes to an error branch of its own accord: a call with no input takes
// Success, and a number the block does not validate is simply accepted, so both
// fall back to where the block goes next unless the flow wires them elsewhere.
function inputAttempts(action: ConnectAction, wanted: string): InputAttemptPlan[] {
  const wrong = wrongStoredInput(wanted, maximumStoredLength(action));

  return [
    {
      attempt: "typed",
      step: { input: wanted, inputType: isDtmf(wanted) ? DTMF_INPUT_TYPE : SPEECH_INPUT_TYPE },
      stored: wanted,
      target: action.Transitions?.NextAction,
    },
    {
      attempt: "timeout",
      step: { exit: "timeout" },
      stored: TIMEOUT_STORED_INPUT,
      target: menuExitTarget(action, "timeout", "dtmf"),
    },
    {
      attempt: "default",
      step: { input: wrong, inputType: DTMF_INPUT_TYPE, exit: "default" },
      stored: wrong,
      target: menuExitTarget(action, "default", "dtmf"),
    },
  ];
}

export type BranchCoverage = Map<
  string,
  {
    flowName: string;
    actionId: string;
    reference?: string;
    branches: Map<string, string>;
    taken: Set<string>;
  }
>;

function branchDescription(condition: ConnectTransitionCondition): string {
  const operator = condition.Condition?.Operator ?? "matches";
  const operands = (condition.Condition?.Operands ?? [])
    .filter((operand) => operand !== undefined && operand !== null)
    .map((operand) => String(operand));
  return operands.length > 0 ? `${operator} ${operands.join(", ")}` : operator;
}

function branchTargets(action: ConnectAction): Map<string, string> {
  const targets = new Map<string, string>();

  for (const condition of action.Transitions?.Conditions ?? []) {
    const target = condition.NextAction;
    if (!target) continue;
    const described = branchDescription(condition);
    const existing = targets.get(target);
    targets.set(target, existing ? `${existing}, ${described}` : described);
  }

  const noMatch = action.Transitions?.NextAction;
  if (noMatch) {
    const existing = targets.get(noMatch);
    targets.set(noMatch, existing ? `${existing}, no matching condition` : "no matching condition");
  }

  return targets;
}

export function enumerateConnectPaths(
  bundle: ConnectBundle,
  options: {
    hooResult: string;
    maxTestCases: number;
    maxMenuDepth: number;
    utterances?: Utterances;
    noMatchUtterance?: string;
    customerQueueFlow?: string;
    storedInputs?: StoredInputs;
    external?: ReadonlyMap<string, string>;
    externalDeclared?: boolean;
    branchCoverage?: BranchCoverage;
    /**
     * A path to follow, where one was written down: every choice this walk would make
     * asks it which single branch to take, so it walks one call and emits one path.
     */
    directed?: DirectedPath;
    warn: (m: string) => void;
  }
): FlowPath[] {
  const paths: FlowPath[] = [];
  const { warn, directed } = options;
  let capped = false;

  const fallbackQueueFlow = options.customerQueueFlow
    ? resolveDependency(bundle, options.customerQueueFlow, options.customerQueueFlow)
    : undefined;
  if (options.customerQueueFlow && !fallbackQueueFlow) {
    warn(
      `The customer queue flow to fall back to, "${options.customerQueueFlow}", is not in the bundle - bundle it under "flows", or name a flow this instance really has, to assert what the caller hears on hold`
    );
  }

  let warnedSilentHold = false;

  const emit = (state: WalkState, note: string, endsAtQueue: boolean, endedWith?: string) => {
    if (paths.length >= options.maxTestCases) {
      if (!capped) {
        capped = true;
        warn(`Hit the ${options.maxTestCases} test case cap - later menu paths were skipped`);
      }
      return;
    }
    const holdFlow = state.customerQueueFlow ?? fallbackQueueFlow;
    const queueMessages = endsAtQueue
      ? customerQueueMessages(holdFlow, state.attributes, state.external)
      : undefined;
    if (endsAtQueue && !queueMessages?.length && !warnedSilentHold) {
      warnedSilentHold = true;
      warn(
        "A path reaches a queue but nothing could be read about what the caller hears on hold, so the test case ends at the transfer - this flow sets no CustomerQueue event hook and no customer queue flow was resolved to stand in for one"
      );
    }
    paths.push({
      labels: [...state.labels],
      trail: [...state.trail],
      steps: state.steps.map((step) => ({ ...step })),
      queueId: state.queueId,
      hooId: state.hooId,
      hooQueueId: state.hooQueueId,
      walkedHoursCheck: state.checkedHours ?? false,
      endsAtQueue,
      endedWith,
      queueMessages,
      externalValues: state.external.size > 0 ? Object.fromEntries(state.external) : undefined,
      lambdaFailure: state.lambdaFailure,
      usedExternalKeys: [...state.usedExternal],
      note,
    });
  };

  const warnedValues = new Set<string>();
  const warnMissingValues = (
    flow: FlowDoc,
    actionId: string,
    action: ConnectAction,
    state: WalkState
  ) => {
    const missing = unknownValueReferences(action, state.attributes, state.external);
    if (missing.length === 0) return;

    const key = `${flow.key}#${actionId}`;
    if (warnedValues.has(key)) return;
    warnedValues.add(key);

    const advice = missing.includes(STORED_INPUT)
      ? 'A "Store customer input" block earlier in the flow is what fills it, and this path reaches none.'
      : missing.some((reference) => reference.startsWith("$.External."))
      ? 'Declaring what the Lambda returns in the flow\'s "<FlowName>.values.json" is what makes it assertable.'
      : 'A "Set contact attributes" block earlier in the flow is what makes it assertable.';

    warn(
      `${flow.name} block ${actionId} plays nothing but ${missing.join(
        ", "
      )}, which nothing before it on this path sets, so there is no text to assert and the prompt is left out of the test case. ${advice}`
    );
  };

  // A "Set working queue" block does not put the caller in a queue - the docs are
  // explicit that a "Transfer to queue" block has to follow it - so a branch that
  // sets the queue, names the flow to play on hold, and then ends the flow leaves
  // the caller hearing "please hold" and then nothing. It is the branch that was
  // wired to the wrong terminal block, and it is worth saying so: no queue is
  // asserted and no hold message is read, because none is played.
  const warnedQueueEnds = new Set<string>();
  const warnQueuedWithoutTransfer = (
    flow: FlowDoc,
    actionId: string,
    type: string,
    state: WalkState
  ) => {
    if (type !== "EndFlowExecution") return;
    if (!state.queueId || !state.setHoldFlow) return;

    const key = `${flow.key}#${actionId}`;
    if (warnedQueueEnds.has(key)) return;
    warnedQueueEnds.add(key);

    warn(
      `${flow.name} block ${actionId} ends the flow on a branch that set the working queue (${
        state.queueId
      }) at ${
        state.queueSetAt ?? "an earlier block"
      } and named a customer queue flow, but nothing on the branch transfers the contact - so the caller is never queued, and the test case asserts no ${QUEUE_TARGET_KEYWORD} and no hold message. Wire that branch into a "Transfer to queue" block to have both.`
    );
  };

  // A path being followed says what matters and leaves the rest alone, so a block it
  // says nothing about gets the obvious answer - the first option, the number that was
  // declared, the value the flow already knows. That is an assumption about a call
  // somebody wrote down deliberately, so it is said out loud, once per block, with the
  // step to write into the path to decide it instead.
  const warnedAssumptions = new Set<string>();
  const warnAssumed = (flow: FlowDoc, actionId: string, did: string, choose: string) => {
    if (!directed) return;
    const key = `${flow.key}#${actionId}#assumed`;
    if (warnedAssumptions.has(key)) return;
    warnedAssumptions.add(key);

    warn(
      `${flow.name} block ${actionId} is on the path "${directed.selector}", which says nothing about it, so ${did}. Write "${choose}" into the path, where the call reaches it, to say otherwise.`
    );
  };

  const warnedBranches = new Set<string>();
  const warnGuessedBranch = (flow: FlowDoc, actionId: string, reference: string | undefined) => {
    const key = `${flow.key}#${actionId}`;
    if (warnedBranches.has(key)) return;
    warnedBranches.add(key);

    warn(
      `${flow.name} block ${actionId} branches on ${
        reference ?? "something this walk cannot read"
      }, which nothing on this path sets, so its first branch was taken. Every prompt asserted after it is only right if the flow really goes that way on the day - declare the value to choose the branch deliberately.`
    );
  };

  const warnedStoredInputs = new Set<string>();
  const warnInventedStoredInput = (
    flow: FlowDoc,
    actionId: string,
    choice: StoredInputChoice
  ) => {
    const key = `${flow.key}#${actionId}`;
    if (warnedStoredInputs.has(key)) return;
    warnedStoredInputs.add(key);

    warn(
      `${flow.name} block ${actionId} stores what the caller types and nothing says what that is, so the test case enters "${choice.value}". A prompt playing it back is still asserted with those digits, because the test case is the caller - but a branch comparing them takes whichever way "${choice.value}" happens to go. Declare it - "stored_input": { "${choice.name}": "..." } in the flow definition or in "<FlowName>.values.json" - to choose it.`
    );
  };

  const warnedLambdas = new Set<string>();
  const warnUnfailableLambda = (flow: FlowDoc, actionId: string) => {
    const key = `${flow.key}#${actionId}#unfailable`;
    if (warnedLambdas.has(key)) return;
    warnedLambdas.add(key);

    warn(
      `${flow.name} block ${actionId} goes somewhere of its own when the invocation fails, but names the function only at runtime - so there is nothing to name that test case after and the branch is left uncovered. Set the function on the block itself to have a test case for it.`
    );
  };

  const warnLiveFailureOnly = (flow: FlowDoc, actionId: string, arn: string) => {
    const key = `${flow.key}#${actionId}#livefailure`;
    if (warnedLambdas.has(key)) return;
    warnedLambdas.add(key);

    warn(
      `${flow.name} block ${actionId} goes somewhere of its own when ${lambdaName(
        arn
      )} fails, so there is a test case for that branch named after it. Nothing makes the invocation fail - the execution calls the real function - so it passes only while that function really is down or too slow to answer, and fails while it is healthy.`
    );
  };

  const warnUndeclaredLambda = (flow: FlowDoc, actionId: string, arn: string | undefined) => {
    const key = `${flow.key}#${actionId}`;
    if (warnedLambdas.has(key)) return;
    warnedLambdas.add(key);

    warn(
      `${flow.name} block ${actionId} invokes ${arn ?? "a Lambda"}, and nothing says what it answers. Every value a "Check contact attributes" block compares it against still gets a test case, read off the block - but the execution calls the real function, so only the branch it answers for passes, and a prompt playing an answer back asserts only the words around it. Declare it in "<FlowName>.values.json" - { "external": { "<key>": "value" } } - to say which answer is the expected one and assert the gap.`
    );
  };

  /**
   * What a path is naming, where the step it names next is a check block reading this.
   *
   * A check goes into a path as the value it read - on its own where the value is a word
   * of its own ("AUTH123456"), or under the name of what was read where it is a number
   * or a true/false ("auth_number-24352", "dicommisioned-false") - so the value is what
   * the path gives and the branch follows from it. That is what turns a declared list of
   * every number a block compares against into one test case per number named: the list
   * says which values there are, and the path says which of them is in force here.
   */
  const directedComparison = (
    action: ConnectAction,
    reference: string | undefined,
    resolved: string | undefined
  ): string | undefined => {
    if (!directed || !reference) return undefined;
    const wanted = wantedSegment(directed);
    if (wanted === undefined) return undefined;

    const read = sanitizeLabel(referenceName(reference));
    const asRead = (value: string): TrailStep => ({
      value: sanitizeLabel(answerLabel(read, value)),
      name: read,
      kind: "check",
    });

    const named = ((): string | undefined => {
      // Under the name of what was read, which names the value whatever the block does
      // with it: a value no condition matches is how a path takes the branch a block
      // takes when none of them do.
      const prefix = `${read.toLowerCase()}-`;
      if (wanted.startsWith(prefix)) {
        const value = wanted.slice(prefix.length);
        return value === "unset" ? UNSET_VALUE : value;
      }

      // What this block is going to read anyway, written out.
      if (
        resolved !== undefined &&
        !DYNAMIC_VALUE_PATTERN.test(resolved) &&
        segmentMatches(lowercased(asRead(resolved)), wanted)
      ) {
        return resolved;
      }

      // On its own, which says which block it belongs to only by being one of the
      // values this block compares against.
      return comparisonOperands(action).find((operand) =>
        segmentMatches(lowercased(asRead(operand)), wanted)
      );
    })();

    if (named === undefined) return undefined;
    takeSegment(directed, wanted);
    return named;
  };

  // An answer a path names is remembered where the block read it from, so everything
  // after it - a prompt playing it back, another block comparing it - sees the value the
  // branch was chosen by.
  const rememberValue = (reference: string, value: string, state: WalkState) => {
    for (const key of externalReferences(reference)) state.external.set(key, value);
    for (const name of attributeReferences(reference)) state.attributes.set(name, value);
    if (reference.includes(STORED_INPUT)) state.attributes.set(STORED_INPUT_KEY, value);
  };

  const comparisonBranch = (
    flow: FlowDoc,
    actionId: string,
    action: ConnectAction,
    state: WalkState
  ): string | undefined => {
    const transitions = action.Transitions ?? {};
    const conditions = transitions.Conditions ?? [];
    const reference = comparisonReference(action);
    const resolved = reference
      ? withKnownValues(reference, state.attributes, state.external)
      : undefined;

    if (reference) noteValueUse(reference, state);

    const coverage = options.branchCoverage;
    const coverageKey = `${flow.key}#${actionId}`;
    if (coverage && !coverage.has(coverageKey)) {
      coverage.set(coverageKey, {
        flowName: flow.name,
        actionId,
        reference,
        branches: branchTargets(action),
        taken: new Set(),
      });
    }
    const took = (target: string | undefined) => {
      if (target) coverage?.get(coverageKey)?.taken.add(target);
      return target;
    };

    // A branch this block really decided, so the value it decided on goes on the
    // trail at the point in the call it was read, under the name of the attribute it
    // read. A guessed branch decides nothing and says nothing.
    const decided = (target: string | undefined, seen: string) => {
      const read = sanitizeLabel(referenceName(reference as string));
      state.trail.push({
        value: sanitizeLabel(answerLabel(referenceName(reference as string), seen)),
        name: read,
        kind: "check",
      });
      return took(target);
    };

    const branchFor = (value: string): string | undefined => {
      for (const condition of conditions) {
        if (conditionHolds(condition, value) === true) return condition.NextAction;
      }
      return transitions.NextAction ?? conditions[0]?.NextAction;
    };

    // The path says what this block reads, so it reads that and goes whichever way that
    // goes - whether or not anything else on this path would have made it read it.
    const forced = directedComparison(action, reference, resolved);
    if (forced !== undefined) {
      directed!.askedAt = `${flow.name} block ${actionId}`;
      rememberValue(reference as string, forced, state);
      return decided(branchFor(forced), forced);
    }

    if (resolved === undefined || DYNAMIC_VALUE_PATTERN.test(resolved)) {
      warnGuessedBranch(flow, actionId, reference);
      return took(conditions[0]?.NextAction ?? transitions.NextAction);
    }

    warnAssumed(
      flow,
      actionId,
      `it read ${reference} as "${resolved === UNSET_VALUE ? "unset" : resolved}" and went the way that goes`,
      sanitizeLabel(answerLabel(sanitizeLabel(referenceName(reference as string)), resolved))
    );

    let undecided = false;
    for (const condition of conditions) {
      const holds = conditionHolds(condition, resolved);
      if (holds === true) return decided(condition.NextAction, resolved);
      if (holds === undefined) undecided = true;
    }

    if (undecided) {
      warnGuessedBranch(flow, actionId, reference);
      return took(conditions[0]?.NextAction ?? transitions.NextAction);
    }

    return decided(transitions.NextAction ?? conditions[0]?.NextAction, resolved);
  };

  const noteValueUse = (text: unknown, state: WalkState) => {
    if (state.external.size === 0) return;
    for (const name of externalReferences(text)) {
      if (state.external.has(name)) state.usedExternal.add(name);
    }
    for (const attribute of attributeReferences(text)) {
      for (const name of state.attributeSource.get(attribute) ?? []) state.usedExternal.add(name);
    }
  };

  const noteExternalUse = (action: ConnectAction, state: WalkState) =>
    noteValueUse(JSON.stringify(action.Parameters ?? {}), state);

  const noteAttributeSource = (action: ConnectAction, state: WalkState) => {
    if (state.external.size === 0) return;
    const attributes = (action.Parameters ?? {}).Attributes;
    if (!attributes || typeof attributes !== "object") return;

    for (const [name, raw] of Object.entries(attributes as Record<string, unknown>)) {
      const sources = new Set<string>();
      for (const key of externalReferences(raw)) {
        if (state.external.has(key)) sources.add(key);
      }
      for (const attribute of attributeReferences(raw)) {
        for (const key of state.attributeSource.get(attribute) ?? []) sources.add(key);
      }
      if (sources.size > 0) state.attributeSource.set(name, [...sources]);
      else state.attributeSource.delete(name);
    }
  };

  const walk = (doc: FlowDoc, startActionId: string | undefined, state: WalkState): void => {
    let current = startActionId;
    let flow = doc;

    for (;;) {
      if (!current) {
        const frame = state.returnStack.pop();
        if (!frame) {
          emit(state, "flow ended without an explicit disconnect", false);
          return;
        }
        flow = frame.doc;
        current = frame.actionId;
        continue;
      }

      const visitKey = `${flow.key}#${current}#${loopSignature(state)}`;
      if (state.visited.has(visitKey)) {
        const repeated = flow.actions[current];
        const repeatedType = repeated?.Type ?? "";
        const repeatedMessage = repeated
          ? promptText(repeated, state.attributes, state.external)
          : undefined;
        if (repeatedMessage && (MESSAGE_TYPES.has(repeatedType) || MENU_TYPES.has(repeatedType))) {
          state.steps.push({ message: repeatedMessage });
        }
        emit(state, `returns to an earlier point in ${flow.name}`, false);
        return;
      }
      state.visited.add(visitKey);

      const action = flow.actions[current];
      if (!action) {
        warn(`${flow.name} references unknown action "${current}" - ending this path`);
        emit(state, `unknown action ${current}`, false);
        return;
      }

      const type = action.Type ?? "";
      const transitions = action.Transitions ?? {};

      if (MESSAGE_TYPES.has(type)) {
        noteExternalUse(action, state);
        const message = promptText(action, state.attributes, state.external);
        if (message) state.steps.push({ message });
        else warnMissingValues(flow, current, action, state);
        current = transitions.NextAction;
        continue;
      }

      if (type === ITERATIVE_MESSAGE_TYPE) {
        noteExternalUse(action, state);
        for (const message of iterativeMessageTexts(action, state.attributes, state.external)) {
          state.steps.push({ message });
        }
        current = transitions.NextAction ?? transitions.Conditions?.[0]?.NextAction;
        continue;
      }

      if (MENU_TYPES.has(type)) {
        noteExternalUse(action, state);
        const message = promptText(action, state.attributes, state.external);
        if (!message) warnMissingValues(flow, current, action, state);
        const kind = menuKind(type);
        const stores = storesInput(action);
        const aliasArn = kind === "lex" ? lexAliasArn(action) : undefined;
        const branches: MenuBranch[] = menuBranches(action).map((branch) => ({
          ...branch,
          ...menuBranchInput(branch.value, kind, aliasArn, options.utterances),
        }));
        const noMatch = noMatchInput(
          branches,
          kind,
          options.noMatchUtterance ?? NO_MATCH_UTTERANCE
        );

        const pending = state.menuChoice.get(current);
        if (pending !== undefined) {
          state.steps.push(menuExitStep(message, pending, noMatch));
          if (stores) {
            // Nothing was typed on a timeout, so what is stored is the word the
            // block leaves behind; on a no-match it is the unoffered key pressed.
            if (pending === "timeout") state.attributes.set(STORED_INPUT_KEY, TIMEOUT_STORED_INPUT);
            else if (noMatch) state.attributes.set(STORED_INPUT_KEY, noMatch.input);
          }
          const target = menuExitTarget(action, pending, kind);
          if (!target) {
            emit(state, `${menuExitNote(pending)}, which the flow does not handle`, false);
            return;
          }
          current = target;
          continue;
        }

        if (branches.length === 0) {
          // A "Store customer input" block offers no options, so there is nothing
          // to branch on - but it does wait for digits, and what the caller types
          // there is the whole story of the block. So it gets a test case for each
          // of the three things a caller does: type the number the flow wants,
          // which comes off the definition; type nothing at all; and type a number
          // the flow was not expecting. Whichever it is, is remembered as the
          // contact's stored input, so that a prompt playing it back, or an
          // attribute copying it, resolves further down this path.
          if (stores) {
            const choice = storedInputFor(flow, current, action, options.storedInputs);
            if (!choice.declared) warnInventedStoredInput(flow, current, choice);
            const attempts = inputAttempts(action, choice.value);

            // Looping back to the block is the same caller at the same block, so
            // they do the same thing again rather than opening three more paths.
            const taken = state.inputChoice.get(current);
            const repeat = taken && attempts.find((attempt) => attempt.attempt === taken);
            if (repeat) {
              state.steps.push({ message, ...repeat.step });
              state.attributes.set(STORED_INPUT_KEY, repeat.stored);
              current = repeat.target;
              continue;
            }

            const at = current;
            const moves: DirectedMove[] = [];
            for (const attempt of attempts) {
              if (attempt.attempt !== "typed" && !attempt.target) continue;
              // The digits typed here name nothing in the label - every caller who
              // types something reaches the same branch - but they are a step of the
              // call all the same, so the trail holds what was typed, under the name
              // a declaration would call this block by. That is what lets a flow with
              // more than one input block have "{ref-number}" mean this one.
              const step: TrailStep = {
                value:
                  attempt.attempt === "typed"
                    ? sanitizeLabel(attempt.stored)
                    : MENU_EXIT_LABELS[attempt.attempt],
                name: sanitizeLabel(choice.name),
              };
              moves.push({
                step,
                described:
                  attempt.attempt === "typed"
                    ? `it types "${attempt.stored}"`
                    : attempt.attempt === "timeout"
                    ? "it types nothing at all"
                    : `it types "${attempt.stored}", which is not the number the flow wants`,
                apply: (into) => {
                  if (attempt.attempt !== "typed") {
                    into.labels.push(MENU_EXIT_LABELS[attempt.attempt]);
                  }
                  into.trail.push({ ...step });
                  into.inputChoice.set(at, attempt.attempt);
                  into.steps.push({ message, ...attempt.step });
                  into.attributes.set(STORED_INPUT_KEY, attempt.stored);
                  return attempt.target;
                },
              });
            }

            if (directed) {
              const named = directedMove(directed, moves);
              const move = named ?? moves[0];
              if (!move) {
                emit(state, `an input block with nothing to type at it`, false);
                return;
              }
              directed.askedAt = `${flow.name} block ${at}`;
              if (!named) {
                warnAssumed(flow, at, move.described, `{${sanitizeLabel(choice.name)}}`);
              }
              current = move.apply(state);
              continue;
            }

            for (const move of moves) {
              const attemptState = cloneState(state);
              walk(flow, move.apply(attemptState), attemptState);
            }
            return;
          }

          if (message) state.steps.push({ message });
          current = transitions.NextAction;
          continue;
        }

        // Looping back to a menu this path already answered is the same caller at the
        // same block, so they press what they pressed before and the call carries on
        // round the loop - the same rule an input block and a timeout already follow.
        // Only a loop the flow itself counts can bring a path back here at all: a
        // return with nothing counting the trips round is the one caught further up,
        // where the path ends. So this runs the loop out to its last iteration and then
        // follows whichever branch the flow takes when it is done, which is the part of
        // a retry loop worth asserting and the part a test case that stopped at the
        // first pass never reached.
        const answered = state.answeredMenus.get(current);
        if (answered) {
          state.steps.push({
            message,
            input: answered.input,
            inputType: answered.inputType,
          });
          if (stores && answered.input !== undefined) {
            state.attributes.set(STORED_INPUT_KEY, answered.input);
          }
          if (!answered.target) {
            emit(state, `pressed ${answered.value} again, which the flow does not handle`, false);
            return;
          }
          current = answered.target;
          continue;
        }

        if (state.labels.length >= options.maxMenuDepth) {
          if (message) state.steps.push({ message });
          warn(
            `Reached the max menu depth of ${options.maxMenuDepth} at ${flow.name} action ${current} - not descending further`
          );
          emit(state, `max menu depth ${options.maxMenuDepth} reached`, false);
          return;
        }

        const at = current;
        const moves: DirectedMove[] = [];

        for (const branch of branches) {
          if (branch.input === undefined) {
            warn(
              `${flow.name} voice menu ${current} branches on intent "${branch.value}" but nothing says what a caller would say to match it - skipping that test case. Give the intent a sample utterance on the bot, or add "utterances": { "${branch.value}": "..." } to the flow definition.`
            );
            continue;
          }
          const input = branch.input;
          moves.push({
            step: { value: sanitizeLabel(branch.value) },
            described: `it presses ${input}`,
            apply: (into) => {
              into.labels.push(branch.value);
              into.trail.push({ value: sanitizeLabel(branch.value) });
              into.answeredMenus.set(at, branch);
              into.steps.push({
                message,
                input,
                inputType: branch.inputType,
              });
              // A block can both offer options and store what was pressed, and then
              // the option pressed is the stored input.
              if (stores) into.attributes.set(STORED_INPUT_KEY, input);
              return branch.target;
            },
          });
        }

        for (const exit of ["timeout", "default"] as MenuExit[]) {
          const target = menuExitTarget(action, exit, kind);
          if (!target) continue;
          if (exit === "default" && !noMatch) {
            warn(
              `${flow.name} menu ${current} leaves nothing this generator could answer with to reach its no-match branch - skipping that test case`
            );
            continue;
          }
          moves.push({
            step: { value: MENU_EXIT_LABELS[exit] },
            described:
              exit === "timeout"
                ? "it presses nothing at all"
                : `it presses ${noMatch?.input}, which the menu does not offer`,
            apply: (into) => {
              into.labels.push(MENU_EXIT_LABELS[exit]);
              into.trail.push({ value: MENU_EXIT_LABELS[exit] });
              into.menuChoice.set(at, exit);
              into.steps.push(menuExitStep(message, exit, noMatch));
              // Nothing was typed on a timeout, so what is stored is the word the
              // block leaves behind; on a no-match it is the unoffered digit the test
              // case pressed. Neither is the number the definition declares.
              if (stores) {
                if (exit === "timeout") into.attributes.set(STORED_INPUT_KEY, TIMEOUT_STORED_INPUT);
                else if (noMatch) into.attributes.set(STORED_INPUT_KEY, noMatch.input);
              }
              return target;
            },
          });
        }

        if (directed) {
          const named = directedMove(directed, moves);
          const move = named ?? moves[0];
          if (!move) {
            emit(state, "a menu with nothing this generator could answer it with", false);
            return;
          }
          directed.askedAt = `${flow.name} block ${at}`;
          if (!named) warnAssumed(flow, at, move.described, moves[0].step.value);
          current = move.apply(state);
          continue;
        }

        for (const move of moves) {
          const branchState = cloneState(state);
          walk(flow, move.apply(branchState), branchState);
        }
        return;
      }

      if (type === LOOP_TYPE) {
        const loopKey = `${flow.key}#${current}`;
        const limit = loopLimit(action, flow, current, warn);
        const iteration = (state.loopCounts.get(loopKey) ?? 0) + 1;
        state.loopCounts.set(loopKey, Math.min(iteration, limit + 1));
        current = loopBranch(action, iteration <= limit ? CONTINUE_LOOPING : DONE_LOOPING);
        continue;
      }

      if (type === WAIT_TYPE) {
        const branch = asyncLambdaWaitBranch(action);
        const returned = branch === undefined ? undefined : conditionTarget(action, branch);

        // A wait held open for an asynchronous invocation ends the moment that
        // invocation answers, and the real function does answer. Following
        // NextAction instead would walk the branch the wait takes when nothing came
        // back, and assert the flow's apology rather than what it does with the
        // result.
        if (returned && state.pendingAsyncLambda) {
          const arn = state.pendingAsyncArn;
          state.pendingAsyncLambda = false;
          state.pendingAsyncArn = undefined;

          // The other way out of the wait is the answer never arriving, which is
          // what this flow does when that function is down - a path of its own,
          // and the only one an asynchronous invocation has: the invoke block
          // itself takes its Success branch whatever the function does.
          const gaveUp = transitions.NextAction ?? conditionTarget(action, WAIT_COMPLETED);
          const waitKey = `${flow.key}#${current}`;
          const failable =
            gaveUp !== undefined &&
            gaveUp !== returned &&
            state.lambdaFailure === undefined &&
            !state.failedOnce.has(waitKey);

          if (failable && directed) {
            // A path being followed is one call, so the answer never arriving is a
            // branch it takes only where it says so - by naming the function that is
            // down, the same way the test case for it is named.
            const named = arn
              ? directedMove(directed, [{ step: { value: sanitizeLabel(`${lambdaName(arn)}-error`) } }])
              : undefined;
            if (named && arn) {
              directed.askedAt = `${flow.name} block ${current}`;
              state.failedOnce.add(waitKey);
              state.lambdaFailure = { arn };
              state.labels.push(named.step.value);
              state.trail.push({ ...named.step });
              warnLiveFailureOnly(flow, current, arn);
              current = gaveUp;
              continue;
            }
          } else if (failable) {
            state.failedOnce.add(waitKey);
            if (arn) {
              const failedState = cloneState(state);
              failedState.lambdaFailure = { arn };
              failedState.labels.push(sanitizeLabel(`${lambdaName(arn)}-error`));
              failedState.trail.push({ value: sanitizeLabel(`${lambdaName(arn)}-error`) });
              walk(flow, gaveUp, failedState);
              warnLiveFailureOnly(flow, current, arn);
            } else {
              warnUnfailableLambda(flow, current);
            }
          }

          current = returned;
          continue;
        }

        if (branch !== undefined) {
          warn(
            `${flow.name} wait ${current} waits for an asynchronous Lambda, and nothing on this path invoked one - taking the branch it takes when the wait ends with nothing`
          );
        }
        current = transitions.NextAction ?? transitions.Conditions?.[0]?.NextAction;
        continue;
      }

      if (type === "CheckHoursOfOperation") {
        state.checkedHours = true;
        const explicit =
          bareId(action.Parameters?.HoursOfOperationId) ??
          metadataId(flow, current, "HoursOfOperationId") ??
          metadataDisplayName(flow, current, "HoursOfOperationId");
        if (explicit) {
          state.hooId = state.hooId ?? explicit;
        } else {
          state.hooQueueId = state.hooQueueId ?? state.queueId;
        }
        current = hoursOfOperationBranch(action, options.hooResult);
        continue;
      }

      if (type === "UpdateContactTargetQueue" || type === "SetWorkingQueue") {
        const queueId = queueFromAction(flow, current, action);
        if (queueId) {
          state.queueId = queueId;
          state.queueSetAt = current;
        }
        current = transitions.NextAction;
        continue;
      }

      if (type === ATTRIBUTE_UPDATE_TYPE) {
        noteAttributeSource(action, state);
        for (const [name, value] of literalAttributeUpdates(
          action,
          state.attributes,
          state.external
        )) {
          state.attributes.set(name, value);
        }
        current = transitions.NextAction;
        continue;
      }

      if (type === LAMBDA_INVOCATION_TYPE) {
        const named = lambdaArn(action) ?? metadataDisplayName(flow, current, "LambdaFunctionARN");
        const resolved = named ? withKnownValues(named, state.attributes, state.external) : undefined;
        const arn =
          resolved && !DYNAMIC_VALUE_PATTERN.test(resolved) ? resolved : undefined;
        const success = transitions.NextAction ?? transitions.Conditions?.[0]?.NextAction;

        if (invokesAsynchronously(action)) {
          // An asynchronous invocation cannot fail here: the block hands the
          // contact on either way, and it is the wait further down that finds out
          // whether the answer came. So the wait is where the failure branches.
          state.pendingAsyncLambda = true;
          state.pendingAsyncArn = arn;
        } else {
          // An invocation that fails is a path of its own, down the block's Error
          // branch - which is the flow's own answer to the function being down,
          // and worth asserting. Only where it goes somewhere else, though: a
          // block whose Error branch rejoins its Success one has nothing more to
          // say, and only one invocation is failed per path, so a flow that
          // invokes three functions gets three failures rather than eight. A loop
          // invoking the same function again is the same invocation, not another
          // one to fail.
          const failed = errorTarget(action);
          const failKey = `${flow.key}#${current}`;
          const failable =
            failed !== undefined &&
            failed !== success &&
            state.lambdaFailure === undefined &&
            !state.failedOnce.has(failKey);

          if (failable && directed) {
            // As with a wait: the invocation this call is about failing is the one the
            // path names, and a path that names none of them is a call where every
            // function answered.
            const named = arn
              ? directedMove(directed, [{ step: { value: sanitizeLabel(`${lambdaName(arn)}-error`) } }])
              : undefined;
            if (named && arn) {
              directed.askedAt = `${flow.name} block ${current}`;
              state.failedOnce.add(failKey);
              state.lambdaFailure = { arn };
              state.labels.push(named.step.value);
              state.trail.push({ ...named.step });
              warnLiveFailureOnly(flow, current, arn);
              current = failed;
              continue;
            }
          } else if (failable) {
            state.failedOnce.add(failKey);
            if (arn) {
              const failedState = cloneState(state);
              failedState.lambdaFailure = { arn };
              failedState.labels.push(sanitizeLabel(`${lambdaName(arn)}-error`));
              failedState.trail.push({ value: sanitizeLabel(`${lambdaName(arn)}-error`) });
              walk(flow, failed, failedState);
              warnLiveFailureOnly(flow, current, arn);
            } else {
              warnUnfailableLambda(flow, current);
            }
          }
        }

        if (options.external && options.external.size > 0) {
          for (const [key, value] of options.external) state.external.set(key, value);
        }
        if (!options.externalDeclared) warnUndeclaredLambda(flow, current, arn);
        current = success;
        continue;
      }

      if (type === EVENT_HOOKS_TYPE) {
        const hook = customerQueueReference(action);
        if (hook !== undefined) {
          state.setHoldFlow = true;
          const target = resolveDependency(
            bundle,
            hook,
            eventHookDisplayName(flow, current, "CustomerQueue")
          );
          if (target) {
            state.customerQueueFlow = target;
          } else {
            warn(
              `${flow.name} sets a customer queue flow that is not in the bundle (${JSON.stringify(
                hook
              )}) - add it under "flows" to assert what the caller hears on hold`
            );
          }
        }
        current = transitions.NextAction;
        continue;
      }

      if (type === "TransferContactToQueue") {
        const queueId = queueFromAction(flow, current, action);
        if (queueId) state.queueId = queueId;
        emit(state, "transferred to queue", true);
        return;
      }

      if (type === FLOW_TRANSFER_TYPE) {
        const target = resolveDependency(
          bundle,
          flowTransferReference(action),
          metadataDisplayName(flow, current, "ContactFlowId")
        );
        if (!target) {
          warn(
            `${flow.name} transfers to a flow that is not in the bundle (${JSON.stringify(
              flowTransferReference(action) ?? null
            )}) - ending this path. Add it under "flows" to cover it.`
          );
          emit(state, "transferred to a flow missing from the bundle", false);
          return;
        }
        flow = target;
        current = target.startAction;
        continue;
      }

      if (type === MODULE_INVOCATION_TYPE) {
        const target = resolveDependency(
          bundle,
          moduleReference(action),
          metadataDisplayName(flow, current, "FlowModuleId")
        );
        if (!target) {
          warn(
            `${flow.name} invokes a module that is not in the bundle (${JSON.stringify(
              moduleReference(action) ?? null
            )}) - stepping over it. Add it under "modules" to cover its prompts.`
          );
          current = transitions.NextAction;
          continue;
        }
        state.returnStack.push({ doc: flow, actionId: transitions.NextAction });
        flow = target;
        current = target.startAction;
        continue;
      }

      if (
        type === "EndFlowModuleExecution" ||
        (type === "EndFlowExecution" && state.returnStack.length > 0)
      ) {
        const frame = state.returnStack.pop();
        if (!frame) {
          emit(state, "module ended", false);
          return;
        }
        flow = frame.doc;
        current = frame.actionId;
        continue;
      }

      if (TERMINAL_TYPES.has(type)) {
        warnQueuedWithoutTransfer(flow, current, type, state);
        emit(
          state,
          type === "DisconnectParticipant" ? "disconnected" : `ended with ${type}`,
          false,
          type
        );
        return;
      }

      if (CONDITION_FIRST_TYPES.has(type)) {
        current = comparisonBranch(flow, current, action, state);
        continue;
      }

      current = transitions.NextAction ?? transitions.Conditions?.[0]?.NextAction;
    }
  };

  walk(bundle.main, bundle.main.startAction, newWalkState());

  return paths;
}

function queueFromAction(flow: FlowDoc, actionId: string, action: ConnectAction): string | undefined {
  return (
    bareId(action.Parameters?.QueueId ?? action.Parameters?.Queue) ??
    metadataId(flow, actionId, "QueueId") ??
    metadataDisplayName(flow, actionId, "QueueId")
  );
}

function hoursOfOperationBranch(action: ConnectAction, hooResult: string): string | undefined {
  const conditions = action.Transitions?.Conditions ?? [];
  const match = (values: string[]) =>
    conditions.find((condition) => {
      const operand = condition.Condition?.Operands?.[0];
      return typeof operand === "string" && values.includes(operand.trim().toLowerCase());
    })?.NextAction;

  return isOutOfHour(hooResult)
    ? match(["false", "outofhours", "outofhour"]) ?? action.Transitions?.NextAction
    : match(["true", "inhours", "inhour"]) ?? action.Transitions?.NextAction;
}

export function branchesOnHoursOfOperation(bundle: ConnectBundle): boolean {
  const docs = new Set<FlowDoc>([bundle.main, ...bundle.dependencies.values()]);

  for (const doc of docs) {
    for (const action of Object.values(doc.actions)) {
      if (action.Type !== "CheckHoursOfOperation") continue;
      const open = hoursOfOperationBranch(action, IN_HOUR);
      const closed = hoursOfOperationBranch(action, OUT_OF_HOUR);
      if (closed && closed !== open) return true;
    }
  }

  return false;
}

function attributeSources(docs: Set<FlowDoc>): Map<string, Set<string>> {
  const sources = new Map<string, Set<string>>();
  const add = (attribute: string, keys: Iterable<string>): boolean => {
    const known = sources.get(attribute) ?? new Set<string>();
    const before = known.size;
    for (const key of keys) known.add(key);
    sources.set(attribute, known);
    return known.size > before;
  };

  let learning = true;
  while (learning) {
    learning = false;
    for (const doc of docs) {
      for (const action of Object.values(doc.actions)) {
        const attributes = (action.Parameters ?? {}).Attributes;
        if (!attributes || typeof attributes !== "object") continue;

        for (const [name, raw] of Object.entries(attributes as Record<string, unknown>)) {
          if (add(name, externalReferences(raw))) learning = true;
          for (const from of attributeReferences(raw)) {
            if (add(name, sources.get(from) ?? [])) learning = true;
          }
        }
      }
    }
  }

  return sources;
}

const INVERTIBLE_OPERATORS = new Set([
  "Equals",
  "TextEquals",
  "NumberEquals",
  "TextStartsWith",
  "TextEndsWith",
  "TextContains",
]);

export function branchValues(bundle: ConnectBundle): ExternalValues {
  const docs = new Set<FlowDoc>([bundle.main, ...bundle.dependencies.values()]);
  const sources = attributeSources(docs);
  const found = new Map<string, Set<string>>();

  for (const doc of docs) {
    for (const action of Object.values(doc.actions)) {
      if (!CONDITION_FIRST_TYPES.has(action.Type ?? "")) continue;

      const reference = comparisonReference(action);
      if (!reference) continue;

      const keys = new Set<string>(externalReferences(reference));
      for (const attribute of attributeReferences(reference)) {
        for (const key of sources.get(attribute) ?? []) keys.add(key);
      }
      if (keys.size === 0) continue;

      const values: string[] = [];
      const reached = new Set<string>();
      for (const condition of action.Transitions?.Conditions ?? []) {
        const operator = condition.Condition?.Operator;
        const operand = condition.Condition?.Operands?.[0];
        if (typeof operator !== "string" || !INVERTIBLE_OPERATORS.has(operator)) continue;
        if (typeof operand !== "string" && typeof operand !== "number") continue;

        values.push(String(operand));
        if (condition.NextAction) reached.add(condition.NextAction);
      }

      const noMatch = action.Transitions?.NextAction;
      if (noMatch && !reached.has(noMatch)) values.push(UNSET_VALUE);

      for (const key of keys) {
        const known = found.get(key) ?? new Set<string>();
        for (const value of values) known.add(value);
        found.set(key, known);
      }
    }
  }

  return Object.fromEntries([...found].map(([key, values]) => [key, [...values]]));
}

export function withBranchValues(
  declared: ExternalValues | undefined,
  fromBranches: ExternalValues
): ExternalValues | undefined {
  if (!declared && Object.keys(fromBranches).length === 0) return undefined;

  const merged: ExternalValues = { ...(declared ?? {}) };
  for (const [key, values] of Object.entries(fromBranches)) {
    const already = merged[key];
    const listed = already === undefined ? [] : Array.isArray(already) ? already : [already];
    merged[key] = [
      ...listed,
      ...(values as string[]).filter(
        (value) => !listed.some((one) => String(one) === value)
      ),
    ];
  }

  return merged;
}

interface MenuTreeOption {
  menu?: string;
  queue?: string;
  flow?: string;
  disconnect?: boolean;
  repeat?: boolean;
  prompts?: string[];
  input_type?: string;
}

interface MenuTreeMenu {
  prompt?: string;
  prompts?: string[];
  options?: Record<string, unknown>;
}

function normalizeOption(raw: unknown, label: string): MenuTreeOption {
  if (typeof raw === "string") {
    const value = raw.trim();
    const [head, ...rest] = value.split(":");
    const tail = rest.join(":").trim();
    switch (head.toLowerCase()) {
      case "queue":
        return { queue: tail || undefined };
      case "flow":
      case "menu":
        return { menu: tail };
      case "disconnect":
      case "end":
      case "hangup":
        return { disconnect: true };
      case "repeat":
      case "skip":
        return { repeat: true };
      default:
        return { menu: value };
    }
  }

  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as MenuTreeOption;
  }

  throw new Error(`Menu option ${label} must be a string or an object`);
}

function outOfHoursBranch(tree: Record<string, any>): MenuTreeOption | undefined {
  const raw = tree.out_of_hours ?? tree.outOfHours ?? tree.closed;
  if (raw === undefined) return undefined;
  return normalizeOption(raw, '"out_of_hours"');
}

export function declaresOutOfHours(tree: Record<string, any>): boolean {
  return outOfHoursBranch(tree) !== undefined;
}

export function enumerateMenuTreeOutOfHoursPaths(
  tree: Record<string, any>,
  options: { warn: (m: string) => void }
): FlowPath[] {
  const branch = outOfHoursBranch(tree);
  if (!branch) {
    options.warn(
      'This definition declares no "out_of_hours" branch, so no closed test case was generated'
    );
    return [];
  }

  const steps: Step[] = [
    ...toStringArray(tree.prompts ?? tree.welcome ?? tree.welcome_message),
    ...toStringArray(branch.prompts),
  ].map((message) => ({ message }));

  return [
    {
      labels: [],
      steps,
      queueId: branch.queue || undefined,
      endsAtQueue: branch.queue !== undefined,
      note: branch.queue !== undefined ? "closed, transferred to queue" : "closed, disconnected",
    },
  ];
}

export function enumerateMenuTreePaths(
  tree: Record<string, any>,
  options: { maxTestCases: number; maxMenuDepth: number; warn: (m: string) => void }
): FlowPath[] {
  const menus = (tree.menus ?? {}) as Record<string, MenuTreeMenu>;
  const menuNames = Object.keys(menus);
  if (menuNames.length === 0) {
    throw new Error('A menu tree definition needs a non-empty "menus" object');
  }

  const start = typeof tree.start === "string" && tree.start ? tree.start : menuNames[0];
  if (!menus[start]) {
    throw new Error(`"start" points at unknown menu "${start}"`);
  }

  const leadingPrompts = toStringArray(tree.prompts ?? tree.welcome ?? tree.welcome_message);
  const paths: FlowPath[] = [];
  const { warn } = options;
  let capped = false;

  const emit = (state: WalkState, note: string, endsAtQueue: boolean) => {
    if (paths.length >= options.maxTestCases) {
      if (!capped) {
        capped = true;
        warn(`Hit the ${options.maxTestCases} test case cap - later menu paths were skipped`);
      }
      return;
    }
    paths.push({
      labels: [...state.labels],
      trail: [...state.trail],
      steps: state.steps.map((step) => ({ ...step })),
      queueId: state.queueId,
      endsAtQueue,
      note,
    });
  };

  const walk = (menuName: string, state: WalkState): void => {
    const menu = menus[menuName];
    if (!menu) {
      warn(`Unknown menu "${menuName}" - ending this path`);
      emit(state, `unknown menu ${menuName}`, false);
      return;
    }

    if (state.visited.has(menuName)) {
      if (menu.prompt) state.steps.push({ message: menu.prompt });
      emit(state, `returns to menu ${menuName}`, false);
      return;
    }
    state.visited.add(menuName);

    for (const prompt of toStringArray(menu.prompts)) {
      state.steps.push({ message: prompt });
    }

    const rawOptions = menu.options ?? {};
    const digits = Object.keys(rawOptions);
    if (digits.length === 0) {
      if (menu.prompt) state.steps.push({ message: menu.prompt });
      emit(state, `menu ${menuName} has no options`, false);
      return;
    }

    if (state.labels.length >= options.maxMenuDepth) {
      if (menu.prompt) state.steps.push({ message: menu.prompt });
      warn(`Reached the max menu depth of ${options.maxMenuDepth} at "${menuName}"`);
      emit(state, `max menu depth ${options.maxMenuDepth} reached`, false);
      return;
    }

    for (const digit of digits) {
      const option = normalizeOption(rawOptions[digit], `"${menuName}"."${digit}"`);
      if (option.repeat) continue;

      const branchState = cloneState(state);
      branchState.labels.push(digit);
      branchState.trail.push({ value: sanitizeLabel(digit) });
      branchState.steps.push({
        message: menu.prompt,
        input: digit,
        inputType: option.input_type ?? (isDtmf(digit) ? DTMF_INPUT_TYPE : SPEECH_INPUT_TYPE),
      });

      for (const prompt of toStringArray(option.prompts)) {
        branchState.steps.push({ message: prompt });
      }

      const nextMenu = option.menu ?? option.flow;
      if (option.queue !== undefined) {
        branchState.queueId = option.queue || branchState.queueId;
        emit(branchState, "transferred to queue", true);
      } else if (option.disconnect) {
        emit(branchState, "disconnected", false);
      } else if (nextMenu) {
        walk(nextMenu, branchState);
      } else {
        warn(`Option "${menuName}"."${digit}" has no target - treating it as a disconnect`);
        emit(branchState, "option has no target", false);
      }
    }
  };

  walk(start, newWalkState(leadingPrompts.map((message) => ({ message }))));

  return paths;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return value ? [value] : [];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

interface Block {
  name: string;
  message: string;
  input?: string;
  inputType?: string;
}

// A prompt is one line of text to a test case, however it is laid out in the flow. A
// "Play prompt" block written over three lines in the console is three lines of the same
// sentence, and Connect matches the sentence, so the line breaks go - here rather than at
// each place a prompt is read, so a menu tree's prompts and a module's are the same.
function oneLine(message: string): string {
  return message.replace(/\s+/g, " ").trim();
}

function stepKind(step: Step): string {
  if (step.exit) return step.exit;
  return step.input ? "menu" : "prompt";
}

function toBlocks(
  steps: Step[],
  warn: (m: string) => void,
  label: string,
  endedWith?: string
): Block[] | undefined {
  const blocks: Block[] = [];

  for (const step of steps) {
    if (step.message) {
      const index = blocks.length + 1;
      blocks.push({
        name: index === 1 ? ENTRY_BLOCK_NAME : `${stepKind(step)}_${index}`,
        message: oneLine(step.message),
        input: step.input,
        inputType: step.inputType,
      });
      continue;
    }

    if (!step.input) continue;

    const previous = blocks[blocks.length - 1];
    if (!previous || previous.input !== undefined) {
      warn(
        `Path ${label} sends "${step.input}" in response to a prompt with no matching text - skipping this test case`
      );
      return undefined;
    }
    previous.input = step.input;
    previous.inputType = step.inputType;
  }

  if (blocks.length === 0) {
    // A test case whose only observation is the block the flow ended on is one
    // Connect will not accept: CreateTestCase answers 400 InvalidTestCaseException,
    // "InvalidEventProblem(observationIdentifier=flow_ended, reason=Invalid action
    // type for FlowActionStarted event)" - it observes four action types and
    // EndFlowExecution is not one of them. So a path with nothing to assert is
    // skipped, and the report says what would make it assertable.
    warn(
      endedWith
        ? `Path ${label} reaches ${endedWith} without a prompt this test case could assert - skipping it. There is nothing an execution could observe, and Connect rejects a test case that only says where the flow ended. A prompt on that branch, or a "Set contact attributes" block giving the prompt it already has some text, is what makes it a test case.`
        : `Path ${label} has no prompt with matching text - skipping this test case`
    );
    return undefined;
  }

  return blocks;
}

export function buildTestCaseItems(paths: FlowPath[], options: GenerateOptions): Record<string, TestCaseItem> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const defaults = options.defaults ?? {};
  const fallbackHooResult = defaults.hours_of_operation_results ?? IN_HOUR;

  const items: Record<string, TestCaseItem> = {};
  const usedLabels = new Set<string>();

  const hoursFromFlow = paths.find((path) => path.hooId)?.hooId;

  // Which paths were asked for. A path nobody asked for is still labelled and still
  // takes its label, so selecting a subset cannot rename the test cases in it - and
  // nothing else is done with it: it is not built, so it says nothing about a prompt
  // it was never going to assert, and a queue or hours it cannot supply is not an
  // error on a path that is not being built.
  const selection = pathSelection(options.paths);
  const built: string[] = [];
  const notBuilt: string[] = [];
  // Both ways of naming each path, for the report a selection that matched nothing
  // gets: the label, and - where it says something different - the order the call
  // made its decisions in.
  const naming = new Map<string, string>();
  // Every name a step of this flow goes by, for the report a "{name}" that is nobody's
  // name gets - kept apart by who decided the step, because only the caller's own
  // steps are what braces stand for.
  const typedNames = new Set<string>();
  const checkedNames = new Set<string>();

  for (const path of paths) {
    const rawLabel = path.name ?? (path.labels.length > 0 ? path.labels.join(".") : "main");
    let label = sanitizeLabel(rawLabel);
    if (usedLabels.has(label)) {
      let suffix = 2;
      while (usedLabels.has(`${label}_${suffix}`)) suffix++;
      label = `${label}_${suffix}`;
    }

    const matched = selection?.wanted(label, path.trail);
    const wanted = !matched || matched.length > 0;

    const blocks = toBlocks(path.steps, wanted ? warn : () => {}, label, path.endedWith);
    if (!blocks) continue;
    usedLabels.add(label);

    for (const step of path.trail ?? []) {
      if (!step.name) continue;
      (step.kind === "check" ? checkedNames : typedNames).add(step.name);
    }

    const trail = (path.trail ?? []).map((step) => step.value).join(".");
    naming.set(label, trail && trail !== label ? `${label} (in flow order: ${trail})` : label);

    if (!wanted) {
      notBuilt.push(label);
      continue;
    }
    if (matched) selection?.keep(matched);
    built.push(label);

    const hooId = path.hooId ?? hoursFromFlow ?? defaults.hours_of_operation;
    if (!hooId) {
      throw new Error(
        `Cannot build test case ${options.flowName}:${label} - no hours of operation id. A CheckHoursOfOperation block in the flow or in one of its modules should supply it, and a branch that queues can have it read off the queue; failing both, add "defaults": { "hours_of_operation": "<id>" } to the flow definition, or set DEFAULT_HOURS_OF_OPERATION on the generator to cover every flow at once.`
      );
    }

    const queueId = path.endsAtQueue ? path.queueId : undefined;
    const endsAtQueue = path.endsAtQueue && Boolean(queueId);
    if (path.endsAtQueue && !endsAtQueue) {
      warn(
        `Path ${label} transfers to a queue but the flow names no queue id on that branch - ending the test on the last prompt instead`
      );
    }

    const item: TestCaseItem = {
      "flow-name": options.flowName,
      "testing-option": label,
      description: `Auto-generated test case for ${options.flowName}: ${
        path.name ? `the declared path ${path.name}` : `menu path ${rawLabel}`
      } (${path.note})`,
      hours_of_operation: hooId,
      hours_of_operation_results: path.hooResult ?? fallbackHooResult,
    };

    if (defaults.caller_number) item.caller_number = defaults.caller_number;
    if (queueId) item.queue = queueId;

    // Nothing here mocks the invocation. The execution calls the real function, and
    // what a declared value buys is the assertion: the test case asserts the prompts
    // of the branch that value takes, so a function answering something else takes
    // the contact elsewhere and the test case fails. That is the check.

    const queueMessages = endsAtQueue ? path.queueMessages ?? [] : [];
    const holdMessages: Block[] = queueMessages.map((message, index) => ({
      name: `${QUEUE_MESSAGE_PREFIX}${index + 1}`,
      message,
    }));

    blocks.forEach((block, index) => {
      const isLast = index === blocks.length - 1;
      const next = isLast
        ? endsAtQueue
          ? QUEUE_TARGET_KEYWORD
          : undefined
        : blocks[index + 1].name;

      item[block.name] = {
        Observe: { message: block.message },
        ...(block.input !== undefined
          ? { Action: { type: block.inputType ?? DTMF_INPUT_TYPE, user_action: block.input } }
          : {}),
        ...(next !== undefined ? { next } : {}),
      };
    });

    if (endsAtQueue && holdMessages.length > 0) {
      item[QUEUE_TARGET_KEYWORD] = { next: holdMessages[0].name };

      holdMessages.forEach((block, index) => {
        const next = holdMessages[index + 1]?.name;
        item[block.name] = {
          Observe: { message: block.message },
          ...(next !== undefined ? { next } : {}),
        };
      });
    }

    items[label] = item;
  }

  if (selection) {
    // A label is generated, not written down anywhere, so a selector that matches
    // nothing is the ordinary mistake here - and the fix is always to read the
    // labels the flow does have, which is why they are listed rather than counted.
    const all = [...built, ...notBuilt].sort();
    for (const selector of selection.unmatched()) {
      warn(
        `Selected path "${selector}" matches none of the ${all.length} path(s) ${options.flowName} has, so no test case was built for it`
      );
    }
    if (selection.unmatched().length > 0) {
      warn(
        `The paths ${options.flowName} has are: ${all
          .map((label) => naming.get(label) ?? label)
          .join(", ")}`
      );

      // "{ref-number}" that no block answers to is a different mistake from a run of
      // steps in the wrong order, and the fix is a different one, so it is reported
      // separately - with the names there are to choose from. A name only a check
      // block goes by is a third mistake again: the name is right, the braces are not.
      const unknown = new Set<string>();
      const readByACheck = new Set<string>();
      const typed = new Set([...typedNames].map((name) => name.toLowerCase()));
      // Matched case-insensitively, reported as the flow spells it: an attribute is
      // "isInHoursEmergency" to whoever has to type it again.
      const checked = new Map([...checkedNames].map((name) => [name.toLowerCase(), name]));
      for (const selector of selection.unmatched()) {
        for (const segment of sanitizeSelector(selector).toLowerCase().split(".")) {
          const named = WILDCARD_SEGMENT.exec(segment)?.[1];
          if (named === undefined || ANY_VALUE_WILDCARDS.has(named) || typed.has(named)) continue;
          const check = checked.get(named);
          if (check) readByACheck.add(check);
          else unknown.add(named);
        }
      }
      if (readByACheck.size > 0) {
        warn(
          `${[...readByACheck]
            .map((name) => `"{${name}}"`)
            .join(
              ", "
            )} is the attribute a "Check contact attributes" block of ${options.flowName} read, and braces stand for what the caller typed - so nothing matches. A check block goes into a selected path as the value it read, like "${
            [...readByACheck][0]
          }-<value>"; the value it read on each path is in the flow order above.`
        );
      }
      if (unknown.size > 0) {
        warn(
          `No step of ${options.flowName} is called ${[...unknown]
            .map((name) => `"{${name}}"`)
            .join(", ")} - a name in braces is the attribute a "Store customer input" block fills, and this flow's are: ${
            [...typedNames].sort().join(", ") || "none"
          }. Use "{}" for a step whose value does not matter and that nothing needs to name.`
        );
      }
    }
    console.log(
      `Selected ${built.length} of ${all.length} path(s) for ${options.flowName}: ${
        built.join(", ") || "none"
      }`
    );
  }

  return items;
}

const CONNECT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConnectLookups {
  queueIdForName(name: string): Promise<string | undefined>;
  hoursOfOperationIdForName(name: string): Promise<string | undefined>;
  hoursOfOperationIdForQueue(queueId: string): Promise<string | undefined>;
  customerQueueFlowIdForName(name: string): Promise<string | undefined>;
  contactFlowDefinition(id: string): Promise<unknown | undefined>;
  contactFlowModuleDefinition(id: string): Promise<unknown | undefined>;
}

export function connectLookups(instanceId: string): ConnectLookups {
  let queueIdsByName: Map<string, string> | undefined;
  let hoursIdsByName: Map<string, string> | undefined;
  let customerQueueFlowIdsByName: Map<string, string> | undefined;
  const hoursByQueue = new Map<string, string | undefined>();

  const loadQueueIds = async (): Promise<Map<string, string>> => {
    if (queueIdsByName) return queueIdsByName;
    const byName = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const page = await connect.send(
        new ListQueuesCommand({
          InstanceId: instanceId,
          QueueTypes: [QueueType.STANDARD],
          NextToken: nextToken,
        })
      );
      for (const queue of page.QueueSummaryList ?? []) {
        if (queue.Name && queue.Id) byName.set(queue.Name.toLowerCase(), queue.Id);
      }
      nextToken = page.NextToken;
    } while (nextToken);
    queueIdsByName = byName;
    return byName;
  };

  const loadHoursIds = async (): Promise<Map<string, string>> => {
    if (hoursIdsByName) return hoursIdsByName;
    const byName = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const page = await connect.send(
        new ListHoursOfOperationsCommand({ InstanceId: instanceId, NextToken: nextToken })
      );
      for (const hours of page.HoursOfOperationSummaryList ?? []) {
        if (hours.Name && hours.Id) byName.set(hours.Name.toLowerCase(), hours.Id);
      }
      nextToken = page.NextToken;
    } while (nextToken);
    hoursIdsByName = byName;
    return byName;
  };

  const loadCustomerQueueFlowIds = async (): Promise<Map<string, string>> => {
    if (customerQueueFlowIdsByName) return customerQueueFlowIdsByName;
    const byName = new Map<string, string>();
    let nextToken: string | undefined;
    do {
      const page = await connect.send(
        new ListContactFlowsCommand({
          InstanceId: instanceId,
          ContactFlowTypes: [ContactFlowType.CUSTOMER_QUEUE],
          NextToken: nextToken,
        })
      );
      for (const flow of page.ContactFlowSummaryList ?? []) {
        if (flow.Name && flow.Id) byName.set(flow.Name.toLowerCase(), flow.Id);
      }
      nextToken = page.NextToken;
    } while (nextToken);
    customerQueueFlowIdsByName = byName;
    return byName;
  };

  const definitions = new Map<string, unknown>();
  const describe = async (
    kind: "module" | "flow",
    id: string,
    send: () => Promise<{ Content?: string; Name?: string } | undefined>
  ): Promise<unknown | undefined> => {
    const cacheKey = `${kind}:${id.toLowerCase()}`;
    if (definitions.has(cacheKey)) return definitions.get(cacheKey);

    let parsed: unknown;
    try {
      const described = await send();
      if (typeof described?.Content !== "string") {
        console.warn(`Connect returned no content for ${kind} ${id}`);
      } else {
        parsed = JSON.parse(described.Content);
        if (described.Name && parsed && typeof parsed === "object") {
          const metadata = (parsed as Record<string, any>).Metadata;
          if (metadata && typeof metadata === "object" && !metadata.name) {
            metadata.name = described.Name;
          }
        }
      }
    } catch (e) {
      console.warn(`Describing ${kind} ${id} failed: ${(e as Error).message}`);
    }

    definitions.set(cacheKey, parsed);
    return parsed;
  };

  return {
    async queueIdForName(name) {
      return (await loadQueueIds()).get(name.trim().toLowerCase());
    },
    async hoursOfOperationIdForName(name) {
      return (await loadHoursIds()).get(name.trim().toLowerCase());
    },
    async customerQueueFlowIdForName(name) {
      return (await loadCustomerQueueFlowIds()).get(name.trim().toLowerCase());
    },
    async hoursOfOperationIdForQueue(queueId) {
      if (hoursByQueue.has(queueId)) return hoursByQueue.get(queueId);
      let hoursId: string | undefined;
      try {
        const described = await connect.send(
          new DescribeQueueCommand({ InstanceId: instanceId, QueueId: queueId })
        );
        hoursId = bareId(described.Queue?.HoursOfOperationId);
      } catch (e) {
        console.warn(`DescribeQueue failed for queue ${queueId}: ${(e as Error).message}`);
      }
      hoursByQueue.set(queueId, hoursId);
      return hoursId;
    },
    async contactFlowDefinition(id) {
      return describe("flow", id, async () => {
        const described = await connect.send(
          new DescribeContactFlowCommand({ InstanceId: instanceId, ContactFlowId: id })
        );
        return described.ContactFlow;
      });
    },
    async contactFlowModuleDefinition(id) {
      return describe("module", id, async () => {
        const described = await connect.send(
          new DescribeContactFlowModuleCommand({ InstanceId: instanceId, ContactFlowModuleId: id })
        );
        return described.ContactFlowModule;
      });
    },
  };
}

export async function resolveFlowResources(
  enumerated: EnumeratedFlow,
  lookups: ConnectLookups,
  warn: (message: string) => void
): Promise<Defaults> {
  const { paths, defaults, fromBundle } = enumerated;

  const queueId = async (value: string | undefined): Promise<string | undefined> => {
    if (!value) return undefined;
    if (CONNECT_ID_PATTERN.test(value)) return value;
    const resolved = await lookups.queueIdForName(value);
    if (!resolved) warn(`No queue named "${value}" on this Connect instance`);
    return resolved;
  };

  const bundleHours = fromBundle.hours_of_operation;
  let hoursFromInstance: string | undefined;

  for (const path of paths) {
    if (path.endsAtQueue) {
      path.queueId = await queueId(path.queueId);
    }

    if (path.hooId && !CONNECT_ID_PATTERN.test(path.hooId)) {
      const byName = await lookups.hoursOfOperationIdForName(path.hooId);
      if (!byName) warn(`No hours of operation named "${path.hooId}" on this Connect instance`);
      path.hooId = byName;
    }

    if (!path.hooId) {
      const source = (await queueId(path.hooQueueId)) ?? (await queueId(path.queueId));
      if (source) {
        path.hooId = await lookups.hoursOfOperationIdForQueue(source);
        if (!path.hooId) {
          warn(`Queue ${source} has no hours of operation to mock`);
        }
      }
    }

    hoursFromInstance = hoursFromInstance ?? path.hooId;
  }

  // What the flow said comes first, then what the bundle declared, and only then
  // the account-wide default. That default is allowed to be a name, because the
  // team setting DEFAULT_HOURS_OF_OPERATION knows "RSA Business Hours" and not a
  // uuid - resolved here, once, so every test case still carries an id.
  let fallbackHours = bundleHours ?? defaults.hours_of_operation;
  if (fallbackHours && !CONNECT_ID_PATTERN.test(fallbackHours)) {
    const byName = await lookups.hoursOfOperationIdForName(fallbackHours);
    if (!byName) {
      warn(
        `No hours of operation named "${fallbackHours}" on this Connect instance - the default to fall back on cannot be resolved. Set DEFAULT_HOURS_OF_OPERATION to an id, or to a name this instance uses.`
      );
    }
    fallbackHours = byName;
  }

  return {
    ...defaults,
    hours_of_operation: hoursFromInstance ?? fallbackHours,
  };
}

function bundleDefaults(bundle: Record<string, any>): Defaults {
  const source = (bundle.defaults ?? bundle.test_case_defaults ?? {}) as Record<string, unknown>;
  const pick = (name: keyof Defaults): string | undefined => {
    const value = source[name] ?? (bundle as Record<string, unknown>)[name];
    if (typeof value === "string" && value) return value;
    if (typeof value === "number") return String(value);
    return undefined;
  };

  return {
    caller_number: pick("caller_number"),
    hours_of_operation: bareId(pick("hours_of_operation")),
    hours_of_operation_results: pick("hours_of_operation_results"),
    no_match_utterance: pick("no_match_utterance"),
    customer_queue_flow: pick("customer_queue_flow"),
  };
}

function mergeDefaults(base: Defaults, override: Defaults): Defaults {
  return {
    caller_number: override.caller_number ?? base.caller_number,
    hours_of_operation: override.hours_of_operation ?? base.hours_of_operation,
    hours_of_operation_results:
      override.hours_of_operation_results ?? base.hours_of_operation_results,
    no_match_utterance: override.no_match_utterance ?? base.no_match_utterance,
    customer_queue_flow: override.customer_queue_flow ?? base.customer_queue_flow,
  };
}

// The defaults a definition or a values file is allowed to set. Every one of them is a
// single value, apart from the hours results, which can be a list of the results to
// generate a test case for.
const DEFAULT_NAMES = new Set<string>([
  "caller_number",
  "hours_of_operation",
  "hours_of_operation_results",
  "customer_queue_flow",
  "no_match_utterance",
]);

interface DeclaredDefaults {
  defaults: Defaults;
  /** The hours results exactly as they were written, because they are allowed to be a list. */
  hoursResults?: unknown;
}

/**
 * The defaults a values file writes down.
 *
 * A definition can carry them itself, but a flow is re-exported from the Connect console
 * every time it changes and anything added to that export by hand goes with it - the same
 * reason "stored_input" belongs in the values file. So the values file can say them, and
 * what it says wins over the definition: which hours of operation to mock, which results
 * to mock it with, the number the test case calls from.
 */
function asDeclaredDefaults(raw: unknown, warn: (message: string) => void): DeclaredDefaults {
  if (raw === undefined || raw === null) return { defaults: {} };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      '"defaults" must hold an object of test case defaults to values - { "defaults": { "hours_of_operation": "RSA Business Hours", "hours_of_operation_results": ["InHour", "OutOfHour"] } }'
    );
  }

  const doc = raw as Record<string, unknown>;
  const known: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(doc)) {
    const key = name.trim().toLowerCase();
    if (DEFAULT_NAMES.has(key)) {
      known[key] = value;
      continue;
    }
    warn(
      `"defaults" names "${name}", which is not a test case default, so it was ignored. The defaults there are: ${[
        ...DEFAULT_NAMES,
      ].join(", ")}.`
    );
  }

  return { defaults: bundleDefaults({ defaults: known }), hoursResults: known.hours_of_operation_results };
}

function looksLikeConnectExport(bundle: Record<string, any>): boolean {
  if (Array.isArray(bundle.Actions)) return true;
  for (const candidate of [bundle.flow, bundle.main_flow, bundle.contact_flow, bundle.content]) {
    if (typeof candidate === "string") return candidate.includes('"Actions"');
    if (typeof candidate === "object" && candidate !== null && Array.isArray((candidate as any).Actions)) {
      return true;
    }
  }
  return false;
}

export interface EnumeratedFlow {
  flowName: string;
  paths: FlowPath[];
  defaults: Defaults;
  fromBundle: Defaults;
  /**
   * Whether these paths were followed rather than found. A path that was followed is
   * already the one that was asked for, so there is nothing left to select from.
   */
  directed?: boolean;
  /**
   * The paths that were written down, with every reference to a declared value filled
   * in - so what is reported as selected or unmatched is what was really looked for.
   */
  selectors?: PathSelectors;
}

function rawHoursResults(bundle: Record<string, any>): unknown {
  const source = (bundle.defaults ?? bundle.test_case_defaults ?? {}) as Record<string, unknown>;
  return source.hours_of_operation_results ?? bundle.hours_of_operation_results;
}

export function hoursResultVariants(
  raw: unknown,
  fallback: string | undefined,
  branchesOnHours: boolean
): string[] {
  const dedupe = (values: string[]): string[] => {
    const seen = new Set<string>();
    return values.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (Array.isArray(raw)) {
    const listed = dedupe(
      raw.filter((value): value is string => typeof value === "string" && value.trim() !== "").map((v) => v.trim())
    );
    if (listed.length > 0) return listed;
  }

  const named = typeof raw === "string" && raw.trim() ? raw.trim() : fallback?.trim() || IN_HOUR;
  if (["both", "all", "inandout"].includes(named.toLowerCase())) return [IN_HOUR, OUT_OF_HOUR];

  return branchesOnHours && !isOutOfHour(named) ? [named, OUT_OF_HOUR] : [named];
}

export function enumerateFlowPaths(parsed: unknown, options: GenerateOptions): EnumeratedFlow {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const bundle = asJsonObject(parsed, "flow definition");
  const flowName = options.flowName;
  if (typeof bundle.flow_name === "string" && bundle.flow_name && bundle.flow_name !== flowName) {
    warn(
      `This definition names the flow "${bundle.flow_name}" but was uploaded to the "${flowName}" folder - the folder wins. Rename the folder if "${bundle.flow_name}" is the flow in Connect.`
    );
  }

  // The values file wins over the definition, and both win over the account-wide
  // defaults, because the definition is a Connect export that gets replaced whole.
  const declaredDefaults = asDeclaredDefaults(options.declaredDefaults, warn);
  const fromBundle = mergeDefaults(bundleDefaults(bundle), declaredDefaults.defaults);
  const defaults = mergeDefaults(options.defaults ?? {}, fromBundle);
  const maxTestCases = options.maxTestCases ?? MAX_TEST_CASES;
  const maxMenuDepth = options.maxMenuDepth ?? MAX_MENU_DEPTH;

  const connectBundle = looksLikeConnectExport(bundle)
    ? parseConnectBundle(bundle, flowName)
    : undefined;
  const isMenuTree = !connectBundle && typeof bundle.menus === "object" && bundle.menus !== null;
  if (!connectBundle && !isMenuTree) {
    throw new Error(
      'Unrecognised flow definition: expected an Amazon Connect export (an "Actions" array, or a "flow" holding one) or a menu tree with a "menus" object'
    );
  }

  const variants = hoursResultVariants(
    declaredDefaults.hoursResults ?? rawHoursResults(bundle),
    defaults.hours_of_operation_results,
    connectBundle ? branchesOnHoursOfOperation(connectBundle) : declaresOutOfHours(bundle)
  );

  const utterances: Utterances = new Map([
    ...(options.utterances ?? new Map<string, string>()),
    ...bundleUtterances(bundle),
  ]);

  const storedInputs = mergeStoredInputs(bundle, options.storedInputs, warn);

  const declared = mergeExternalValues(bundle, options.externalValues);
  const cover = options.coverBranchValues ?? coversBranchValues();
  const externalSets = externalVariants(
    connectBundle && cover ? withBranchValues(declared, branchValues(connectBundle)) : declared,
    warn
  );

  const branchCoverage: BranchCoverage = new Map();

  const paths: FlowPath[] = [];

  // Paths that were written down are followed, one test case each, and nothing else is
  // walked: the flow is not enumerated and then filtered, so a flow with more branches
  // than the cap allows, or one whose steps are named differently from how the walk
  // would name them, still builds the test cases that were asked for. Only an export
  // can be followed - a menu tree has no blocks to consult - so a menu tree keeps
  // picking from what it enumerates.
  // Written down, then written out: a path names the journeys it goes through and the
  // values the file declares, and both are filled in before anything is followed - so
  // what is followed is the whole call, and what it is named is the line that asked.
  const written = options.paths ?? [];
  const selectors = resolveDeclaredReferences(
    expandJourneys(written, asPathJourneys(options.journeys, warn), warn),
    storedInputs,
    declared,
    warn
  );
  // The same lines with the journeys left as the names they were written as, which is
  // what the test case is called: a journey is a stretch of the call and stays short,
  // while a value a step refers to is written into the name, because the value is the
  // whole point of that step. Said once already, above, so this pass says nothing.
  const names = resolveDeclaredReferences(written, storedInputs, declared, () => {});
  if (selectors.length > 0 && !connectBundle) {
    warn(
      `A menu tree definition cannot be followed a step at a time, so the ${selectors.length} declared path(s) pick from the paths it has instead of building the test case out of the path itself. Export the flow from Amazon Connect to have the path followed.`
    );
  }

  if (selectors.length > 0 && connectBundle) {
    // One set of Lambda answers, not one per combination: what is declared once is in
    // force, the first of a declared list is what a path that says nothing about it
    // gets, and a path that names one of the other values is what puts that one in
    // force. So a list of every number a block compares against is a list of the test
    // cases that can be written, one per line of "paths", rather than a fan-out of all
    // of them.
    const answers = externalSets[0]?.values ?? new Map<string, string>();

    for (const [index, selector] of selectors.entries()) {
      if (paths.length >= maxTestCases) {
        warn(`Hit the ${maxTestCases} test case cap - later declared paths were skipped`);
        break;
      }

      const plan = directedPath(selector);
      // Whether the flow is closed is not a step of the call, it is the day the call is
      // made on, so a path says it wherever it likes and it is taken out of the steps.
      const hours =
        variants.find((variant) => plan.segments.includes(sanitizeLabel(variant).toLowerCase())) ??
        variants[0];
      const named = sanitizeLabel(hours).toLowerCase();
      plan.segments = plan.segments.filter((segment) => segment !== named);

      const walked = enumerateConnectPaths(connectBundle, {
        hooResult: hours,
        maxTestCases: 1,
        maxMenuDepth,
        utterances,
        noMatchUtterance: defaults.no_match_utterance,
        customerQueueFlow: defaults.customer_queue_flow,
        storedInputs,
        external: answers,
        externalDeclared: declared !== undefined && Object.keys(declared).length > 0,
        directed: plan,
        warn,
      });

      const followed = walked[0];
      if (!followed || plan.cursor < plan.segments.length) {
        throw new Error(followingFailed(flowName, plan, followed));
      }

      followed.hooResult = hours;
      // Named after the path as it was written, journeys and all: what was asked for is
      // what the test case is called, so it can be found again by the line that asked.
      followed.name = pathName(names[index] ?? selector);
      paths.push(followed);
    }

    return { flowName, paths, defaults, fromBundle, directed: true, selectors };
  }

  variants.forEach((variant, index) => {
    if (maxTestCases - paths.length <= 0) return;

    let walked: FlowPath[] = [];
    const seen = new Set<string>();

    if (connectBundle) {
      externalSets.forEach((answers) => {
        const remaining = maxTestCases - paths.length - walked.length;
        if (remaining <= 0) return;

        for (const path of enumerateConnectPaths(connectBundle, {
          hooResult: variant,
          maxTestCases: remaining,
          maxMenuDepth,
          utterances,
          noMatchUtterance: defaults.no_match_utterance,
          customerQueueFlow: defaults.customer_queue_flow,
          storedInputs,
          external: answers.values,
          externalDeclared: declared !== undefined && Object.keys(declared).length > 0,
          branchCoverage,
          warn,
        })) {
          const used = path.usedExternalKeys ?? [];
          const readFanned = answers.fanned.filter((key) => used.includes(key));

          const signature = [
            ...path.labels,
            ...readFanned.map((key) => `${key}=${answers.values.get(key)}`),
          ].join("");
          if (seen.has(signature)) continue;
          seen.add(signature);

          if (readFanned.length > 0) {
            path.labels = [
              ...path.labels,
              ...readFanned.map((key) => answerLabel(key, answers.values.get(key) ?? key)),
            ];
          }
          walked.push(path);
        }
      });
    } else {
      const remaining = maxTestCases - paths.length;
      walked = isOutOfHour(variant)
        ? enumerateMenuTreeOutOfHoursPaths(bundle, { warn })
        : enumerateMenuTreePaths(bundle, { maxTestCases: remaining, maxMenuDepth, warn });
    }

    if (isOutOfHour(variant)) {
      walked = walked.filter((path) => path.walkedHoursCheck !== false);
      if (walked.length === 0) {
        warn(
          `Nothing in this flow depends on being closed, so no "${variant}" test case was generated`
        );
      }
    }

    for (const path of walked) {
      path.hooResult = variant;
      if (index > 0) {
        path.labels = [sanitizeLabel(variant), ...path.labels];
        path.trail = [{ value: sanitizeLabel(variant) }, ...(path.trail ?? [])];
      }
      paths.push(path);
    }
  });

  reportUncoveredBranches(branchCoverage, warn);

  return { flowName, paths, defaults, fromBundle, selectors };
}

function reportUncoveredBranches(coverage: BranchCoverage, warn: (m: string) => void): void {
  for (const block of coverage.values()) {
    const missed = [...block.branches].filter(([target]) => !block.taken.has(target));
    if (missed.length === 0) continue;

    warn(
      `${block.flowName} block ${block.actionId} branches on ${
        block.reference ?? "something this walk cannot read"
      } and ${missed.length} of its ${block.branches.size} branches ${
        missed.length === 1 ? "was" : "were"
      } never taken: ${missed
        .map(([, described]) => `"${described}"`)
        .join(", ")}. Declaring the value that takes it covers it - a list of values covers one test case each, and "null" is the answer the function does not give, which is what "no matching condition" tests.`
    );
  }
}

export function generateTestCases(
  parsed: unknown,
  options: GenerateOptions
): Record<string, TestCaseItem> {
  const enumerated = enumerateFlowPaths(parsed, options);
  return buildTestCaseItems(enumerated.paths, {
    ...options,
    // A path that was followed is the one that was asked for, so there is nothing to
    // select and nothing to report as unmatched.
    paths: enumerated.directed ? undefined : enumerated.selectors,
    flowName: enumerated.flowName,
    defaults: enumerated.defaults,
  });
}

export async function generateTestCasesWithConnect(
  parsed: unknown,
  options: GenerateOptions,
  lookups: ConnectLookups,
  lex?: LexLookups
): Promise<Record<string, TestCaseItem>> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const definition = await resolveFlowDependencies(
    parsed,
    lookups,
    warn,
    options.defaults?.customer_queue_flow
  );
  const utterances = lex
    ? await resolveSpeechInputs(definition, lex, warn)
    : options.utterances;
  const enumerated = enumerateFlowPaths(definition, { ...options, utterances });
  const defaults = await resolveFlowResources(enumerated, lookups, warn);
  return buildTestCaseItems(enumerated.paths, {
    ...options,
    paths: enumerated.directed ? undefined : enumerated.selectors,
    flowName: enumerated.flowName,
    defaults,
  });
}

function objectKey(record: S3EventRecord): string {
  return decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));
}

async function streamToString(body: any): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

const VALUES_SUFFIX = ".values.json";

export function flowNameFromKey(key: string): string {
  const relative = key.startsWith(FLOW_DEFINITION_PREFIX)
    ? key.slice(FLOW_DEFINITION_PREFIX.length)
    : key;
  const segments = relative.split("/").filter(Boolean);
  if (segments.length === 1 && segments[0].toLowerCase().endsWith(VALUES_SUFFIX)) {
    throw new Error(
      `${key} declares what a Lambda returns, not a flow - the flow itself is ${FLOW_DEFINITION_PREFIX}${segments[0].slice(
        0,
        -VALUES_SUFFIX.length
      )}.json`
    );
  }
  const file = segments.length === 1 ? segments[0] : undefined;
  const flowName = file && /\.json$/i.test(file) ? file.slice(0, -".json".length) : "";

  if (!flowName) {
    throw new Error(
      `${key} is not a flow definition - upload it as ${FLOW_DEFINITION_PREFIX}<FlowName>.json, named for the contact flow in Connect, so the flow name is known`
    );
  }

  return flowName;
}

export function valuesFlowName(key: string): string | undefined {
  const relative = key.startsWith(FLOW_DEFINITION_PREFIX)
    ? key.slice(FLOW_DEFINITION_PREFIX.length)
    : key;
  const segments = relative.split("/").filter(Boolean);
  const file = segments.length === 1 ? segments[0] : undefined;
  if (!file || !file.toLowerCase().endsWith(VALUES_SUFFIX)) return undefined;

  const flowName = file.slice(0, -VALUES_SUFFIX.length);
  return flowName || undefined;
}

export function definitionKey(flowName: string): string {
  return `${FLOW_DEFINITION_PREFIX}${flowName}.json`;
}

export function valuesKey(flowName: string): string {
  return `${FLOW_DEFINITION_PREFIX}${flowName}${VALUES_SUFFIX}`;
}

export function generatedKey(flowName: string): string {
  return `${TEST_CASE_DATA_PREFIX}${flowName}.json`;
}

async function objectStillExists(bucket: string, key: string): Promise<boolean> {
  const page = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: key, MaxKeys: 1 })
  );

  return page.Contents?.[0]?.Key === key;
}

interface Definition {
  key: string;
  parsed: unknown;
}

async function readDefinition(bucket: string, key: string): Promise<Definition> {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = await streamToString(object.Body);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new Error(`s3://${bucket}/${key} is not valid JSON: ${(e as Error).message}`);
  }

  return { key, parsed };
}

function isMissingObject(error: unknown): boolean {
  const { name, $metadata } = (error ?? {}) as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === "NoSuchKey" || name === "NotFound" || $metadata?.httpStatusCode === 404;
}

// The keys the sidecar uses for itself. Everything else in a file that names no
// section at all is read as "$.External" keys, which is all this file held
// before it also carried what a caller types.
const SIDECAR_SECTIONS = new Set([
  "external",
  "external_values",
  "stored_input",
  "stored_inputs",
  "paths",
  "path",
  "only",
  "select",
  "test_cases",
  "defaults",
  "test_case_defaults",
  "journeys",
  "journey",
  "fragments",
  "path_parts",
  "parts",
]);

interface DeclaredValues {
  external?: ExternalValues;
  storedInputs?: StoredInputs;
  paths?: PathSelectors;
  /** The "defaults" section, as it was written - checked where the flow is read. */
  defaults?: unknown;
  /** The "journeys" section, as it was written - the stretches a path can name. */
  journeys?: unknown;
}

async function readDeclaredValues(
  bucket: string,
  flowName: string,
  warn: (message: string) => void
): Promise<DeclaredValues> {
  const key = valuesKey(flowName);

  let definition: Definition;
  try {
    definition = await readDefinition(bucket, key);
  } catch (e) {
    if (isMissingObject(e)) return {};
    throw e;
  }

  const source = `s3://${bucket}/${key}`;
  const doc = asJsonObject(definition.parsed, source);
  const storedInputs = asStoredInputs(doc.stored_input ?? doc.stored_inputs, warn);
  const paths = asPathSelectors(
    doc.paths ?? doc.path ?? doc.only ?? doc.select ?? doc.test_cases,
    warn
  );

  // A default written straight into the file, outside "defaults", is still a default and
  // not an "$.External" key - nothing in a flow reads "$.External.hours_of_operation".
  // It is read as the default it plainly is, and said so, and what "defaults" says wins.
  const section = doc.defaults ?? doc.test_case_defaults;
  const loose = Object.entries(doc).filter(([name]) => DEFAULT_NAMES.has(name.trim().toLowerCase()));
  for (const [name] of loose) {
    warn(
      `${source} writes "${name}" on its own, outside "defaults". It is a test case default rather than an "$.External" key, so it was read as one - move it inside "defaults" to say so.`
    );
  }
  const defaults =
    loose.length === 0
      ? section
      : typeof section === "object" && section !== null && !Array.isArray(section)
      ? { ...Object.fromEntries(loose), ...section }
      : section ?? Object.fromEntries(loose);

  const journeys =
    doc.journeys ?? doc.journey ?? doc.fragments ?? doc.path_parts ?? doc.parts;

  const wrapped = doc.external ?? doc.external_values;
  const raw =
    wrapped ??
    Object.fromEntries(
      Object.entries(doc).filter(
        ([name]) =>
          !SIDECAR_SECTIONS.has(name.trim().toLowerCase()) &&
          !DEFAULT_NAMES.has(name.trim().toLowerCase())
      )
    );
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `${source} must hold an object of "$.External" keys to values - { "external": { "customerType": ["gold", "standard"] } }`
    );
  }

  const external = Object.keys(raw).length > 0 ? (raw as ExternalValues) : undefined;
  console.log(
    `${source} declares ${
      [
        ...Object.keys(external ?? {}),
        ...Object.keys(storedInputs ?? {}).map((name) => `${name} (customer input)`),
        ...(typeof defaults === "object" && defaults !== null && !Array.isArray(defaults)
          ? Object.keys(defaults).map((name) => `${name} (default)`)
          : []),
        ...(typeof journeys === "object" && journeys !== null && !Array.isArray(journeys)
          ? Object.keys(journeys).map((name) => `${name} (journey)`)
          : []),
        ...(paths ? [`${paths.length} selected path(s): ${paths.join(", ")}`] : []),
      ].join(", ") || "nothing"
    }`
  );
  return { external, storedInputs, paths, defaults, journeys };
}

async function writeGeneratedConfig(
  bucket: string,
  flowName: string,
  definition: Definition
): Promise<number> {
  const source = `s3://${bucket}/${definition.key}`;

  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    console.warn(`${source}: ${message}`);
  };

  const declared = await readDeclaredValues(bucket, flowName, warn);

  const items = await generateTestCasesWithConnect(
    definition.parsed,
    {
      flowName,
      defaults: ENV_DEFAULTS,
      declaredDefaults: declared.defaults,
      externalValues: declared.external,
      storedInputs: declared.storedInputs,
      paths: declared.paths,
      journeys: declared.journeys,
      warn,
    },
    connectLookups(INSTANCE_ID),
    lexLookups()
  );

  const labels = Object.keys(items);
  if (labels.length === 0) {
    throw new Error(`${source} produced no test cases. Warnings: ${warnings.join("; ") || "none"}`);
  }

  const target = generatedKey(flowName);
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: target,
      Body: JSON.stringify(items, null, 2),
      ContentType: "application/json",
    })
  );

  console.log(
    `Generated ${labels.length} test case(s) for ${flowName} from ${source} -> s3://${bucket}/${target}: ${labels.join(", ")}`
  );
  return labels.length;
}

async function generateRecord(record: S3EventRecord): Promise<number> {
  const bucket = record.s3.bucket.name;
  const key = objectKey(record);
  const flowName = flowNameFromKey(key);

  return writeGeneratedConfig(bucket, flowName, await readDefinition(bucket, key));
}

export function testCaseNamePrefix(flowName: string): string {
  return `${flowName}:`;
}

async function deleteFlowTestCases(flowName: string): Promise<number> {
  const prefix = testCaseNamePrefix(flowName);

  const ids: string[] = [];
  let nextToken: string | undefined;

  do {
    const page = await connect.send(
      new ListTestCasesCommand({ InstanceId: INSTANCE_ID, NextToken: nextToken })
    );
    for (const testCase of page.TestCaseSummaryList ?? []) {
      if (testCase.Id && testCase.Name?.startsWith(prefix)) ids.push(testCase.Id);
    }
    nextToken = page.NextToken;
  } while (nextToken);

  let deleted = 0;
  for (const id of ids) {
    try {
      await connect.send(new DeleteTestCaseCommand({ InstanceId: INSTANCE_ID, TestCaseId: id }));
      deleted++;
    } catch (e) {
      if ((e as { name?: string })?.name !== "ResourceNotFoundException") throw e;
      console.log(`Test case ${id} for ${flowName} was already deleted`);
    }
  }

  return deleted;
}

interface RecordCounts {
  removed: number;
  testCasesDeleted: number;
}

async function removeRecord(record: S3EventRecord): Promise<RecordCounts> {
  const bucket = record.s3.bucket.name;
  const key = objectKey(record);
  const source = `s3://${bucket}/${key}`;

  let flowName: string;
  try {
    flowName = flowNameFromKey(key);
  } catch (e) {
    console.log(`Nothing was generated from ${source}, so nothing to remove: ${(e as Error).message}`);
    return { removed: 0, testCasesDeleted: 0 };
  }

  if (await objectStillExists(bucket, key)) {
    console.log(`${source} still exists (noncurrent version removed) - keeping the generated config`);
    return { removed: 0, testCasesDeleted: 0 };
  }

  const target = generatedKey(flowName);

  let removed = 0;
  if (await objectStillExists(bucket, target)) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: target }));
    console.log(`Removed s3://${bucket}/${target}, which was generated from ${source}`);
    removed = 1;
  } else {
    console.log(`No generated config at s3://${bucket}/${target} to remove`);
  }

  const testCasesDeleted = await deleteFlowTestCases(flowName);
  console.log(
    `Deleted ${testCasesDeleted} test case(s) named ${testCaseNamePrefix(flowName)}* in Connect, now that ${source} is gone`
  );

  return { removed, testCasesDeleted };
}

async function regenerateForValues(record: S3EventRecord, flowName: string): Promise<number> {
  const bucket = record.s3.bucket.name;
  const source = `s3://${bucket}/${objectKey(record)}`;
  const key = definitionKey(flowName);

  let definition: Definition;
  try {
    definition = await readDefinition(bucket, key);
  } catch (e) {
    if (!isMissingObject(e)) throw e;
    console.log(
      `${source} declares values for ${flowName}, which has no definition at s3://${bucket}/${key} - nothing to generate. Upload the flow and the declared values are picked up with it.`
    );
    return 0;
  }

  console.log(`${source} changed - regenerating ${flowName} from s3://${bucket}/${key}`);
  return writeGeneratedConfig(bucket, flowName, definition);
}

export const handler = async (event: S3Event, context: Context) => {
  let generated = 0;
  let removed = 0;
  let testCasesDeleted = 0;

  for (const record of event.Records ?? []) {
    const declaresValuesFor = valuesFlowName(objectKey(record));
    if (declaresValuesFor) {
      generated += await regenerateForValues(record, declaresValuesFor);
      continue;
    }

    if (record.eventName?.startsWith("ObjectRemoved:")) {
      const counts = await removeRecord(record);
      removed += counts.removed;
      testCasesDeleted += counts.testCasesDeleted;
    } else {
      generated += await generateRecord(record);
    }
  }

  return {
    statusCode: 200,
    test_cases_generated: generated,
    configs_removed: removed,
    test_cases_deleted: testCasesDeleted,
    function_name: context.functionName,
  };
};
