# Flow definitions

Drop a flow definition here and every test case for that flow is generated for
you, instead of hand-writing one config per menu option.

```
flow-definition/<FlowName>.json         <- what you upload
        |  rsa-flow-test-cases-gen-cdk   (enumerates every menu path)
        v
test-case-data/<FlowName>.json          <- every test case for that flow
        |  rsa-test-cases-loader-cdk     (loads them into DynamoDB)
        v
        |  rsa-universal-test-cases-cdk  (table stream)
        v
   Amazon Connect test cases, created and executed
        |  rsa-test-results-cdk          (one row per execution)
        v
test-case-results/<FlowName>.xlsx       <- that flow's results, on their own
```

The same rows also go into `test-execution-results.xlsx` at the root of the
bucket, which is every flow's results in one workbook. The per-flow one is named
after the flow the execution actually ran against — the same value as its
`Flow/Number` column — so a single flow's report can be handed over without
everybody else's runs in it.

Every execution of every path gets a row, stamped with when it ran in the last
column — South African time, year first, so the column sorts in the order the runs
happened. An execution runs for up to ten minutes,
so `rsa-test-results-cdk` waits for one; a result it runs out of time for is handed
back to be picked up again rather than dropped, and the rows already written are
not written a second time when it is. Each write is conditional on the version of
the workbook the row was appended to, so results finishing at the same moment queue
up behind each other instead of overwriting one another. A workbook short of a row
means the execution behind it never finished — check that function's logs.

**Test cases are started five at a time.** Connect runs five test case executions
per instance at once, so `rsa-universal-test-cases-cdk` starts five, waits for all
five to reach `PASSED`/`FAILED`/`STOPPED`, and only then starts the next five —
which is why a flow with twenty paths takes several rounds of up to ten minutes
each to report in full, rather than failing nineteen of them on the quota. The
table stream delivers five records per invocation and will not deliver the next
five until the invocation returns, so nothing else can spend those slots
meanwhile; a batch the fifteen-minute clock cannot fit is handed back and picked
up again with a fresh one. Two flows uploaded together are therefore run one after
the other, not side by side. If the concurrency quota on the instance is raised,
`MAX_CONCURRENT_EXECUTIONS` in `universal-test-cases-gen.ts` and the event
source's `batchSize` are the two numbers to raise together.

`<FlowName>` **must be the name of the contact flow in Connect**: the file name
*is* the flow name. It becomes the `flow-name` key, which
`universal-test-cases-gen` resolves through `ListContactFlows`. Sub-folders are
refused rather than guessed at, since a key like
`flow-definition/BM-Test-IaC-Flow/flow.json` gives no reliable flow name.

One flow, one definition, one config, one set of test cases. That is a property
of the key rather than a rule to enforce: S3 cannot hold two objects at
`flow-definition/<FlowName>.json`, so a flow can never have two definitions
competing to generate its config. It mirrors the table the config is loaded into,
where `flow-name` is the partition key — and it means one key to delete at each
step to undo all of it.

**A hand-authored `test-case-data/<FlowName>.json` is overwritten** if a flow
definition for the same `<FlowName>` is uploaded. Give a hand-written config a
name no flow definition uses.

Nothing inside the definition can override the name — a `flow_name` left in a
bundle is ignored, and logged as a warning if it disagrees with the file name.
Renaming the flow means renaming the file.

Everything in this folder is uploaded by the build (`buildspec.yml`), and the
same prefix doubles as a manual drop-box — uploading straight to
`s3://rsa-automated-test-cases-results/flow-definition/` works too.

## What gets generated

One test case per path a caller can take through the menus, labelled by whatever
the caller does to get there — the digits pressed on a DTMF menu, or the intent
matched on a voice one. That label is the `testing-option` sort key, so the
results report reads `1`, `1.2`, `1.1.1`, or `bs-sales`,
`bs-technical.bs-technical-wifi`. `*` and `#` are spelled out as `star` and
`hash`, so a repeat option shows up as `1.star`.

Where a flow also branches on what a Lambda answered, that path is generated once per
branch and the label says which: `1.dicommisioned-false.isInHoursEmergency-true`. See
[Values a Lambda returns](#values-a-lambda-returns).

A path becomes a chain of blocks: `welcome_message` first, then one block per
prompt, each carrying the prompt text to assert on and what to send in response.
A path that reaches a queue transfer asserts `check_queue` with the queue id set;
a path that reaches a disconnect ends on its last prompt.

**A prompt is one line of text, however it is laid out.** A `Play prompt` block
written over three lines in the console is three lines of one sentence, and
Connect matches the sentence, so every line break and run of spaces in it becomes
a single space: `"Press one for sales.\nPress two for support."` is asserted as
`Press one for sales. Press two for support.` That holds for every source of a
prompt — exports, menu trees, modules, transferred-to flows, hold messages — and
for a config already in the table, which is collapsed on its way to Connect too,
so a hand-written `message` need not be one line either.

Where the customer queue flow has something to say, it is asserted as
`queue_message_1`, `queue_message_2`, … chained off `check_queue`, so the chain
runs `… → check_queue → queue_message_1 → …` and ends on the last hold message.
Connect raises the transfer before the customer queue flow plays anything, and a
test case only ever looks forward: asserted the other way round, the transfer has
already happened by the time the test case starts watching for it, and the
`check_queue` observation times out on a contact that really did queue. Every path
that queues gets those blocks, the `Timeout` and `Default` paths included: they
reach the queue by a longer route, not a different one.

Which flow those messages are read from is the flow's own
`UpdateContactEventHooks` block, where it sets one. A flow that sets none — or
that sets one on some branches only — leaves the caller in the instance's default
customer queue flow, and Connect's own default is a flow named **Default customer
queue**. Nothing in an export names it, so the generator looks it up by name; set
`DEFAULT_CUSTOMER_QUEUE_FLOW` on the generator lambda if this instance's default
has been renamed. When no such flow can be read, the chain ends on the flow's own
last prompt and the log says so — the test case is still valid, it just asserts
less than the caller hears.

The two ways of *not* answering a menu are paths too, and are generated:

- **`Timeout`** — the menu is reached and nothing is sent, so the flow takes the
  branch it takes when the caller says or presses nothing.
- **`Default`** — the menu is answered with something it does not offer: an
  unused digit on a DTMF menu, and on a voice menu a phrase no bot should match
  to any intent (see `no_match_utterance` below).

A `Store customer input` block gets both too, since it is a block the caller can
also fail to answer: see [the caller who types nothing, and the caller who types
the wrong number](#the-caller-who-types-nothing-and-the-caller-who-types-the-wrong-number).

Both are labelled off the block they happen at, so a submenu's are
`1.Timeout` / `1.Default`. A retry loop is walked to its end: the flow's
`Loop` block re-prompts, the test case fails to answer again, and the path
continues until the loop is done — so a `LoopCount` of 2 asserts the prompt three
times, then whatever the flow does when it gives up.

**Repeat loops** end rather than expanding: an option that leads back to a menu
already answered on that path becomes a single test case asserting the prompt is
played again, and then ends there. Without that, a repeat option would go on
forever.

Guardrails: `MAX_TEST_CASES` (200) and `MAX_MENU_DEPTH` (10) on the generator
function. Both are logged when hit.

## Writing down which paths get a test case

Every path is generated by default, and for a flow that also branches on what a
Lambda answered that is a lot of them: `BM-Test-IaC-Flow` has 65, and Connect runs
five executions at a time for up to ten minutes each. Write down the calls you want
tested and those are the test cases:

```json
{
  "external": {
    "dicommisioned": ["false", "true"],
    "auth_number": ["24352", "24680", "AUTH123456"]
  },
  "stored_input": { "ref-number": "24680" },
  "paths": [
    "dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.24352",
    "dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.24680",
    "dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.1.AUTH123456"
  ]
}
```

Three lines, three test cases — one per number the lookup can answer with, each one
the same call up to the point where the answer differs.

It goes in the same `flow-definition/<FlowName>.values.json` as the declared values
— [Values a Lambda returns](#values-a-lambda-returns) — and a values file holding
nothing but `paths` is fine. `paths` is the key; `select`, `only`, `path` and
`test_cases` are read the same way.

**A path is followed, not looked for.** The flow is walked once per line, and at
every point it offers a choice the line says which one to take. So a line is a test
case whether or not the walk would have produced that path on its own: a flow with
more branches than `MAX_TEST_CASES` allows, a value only one line mentions, a
combination the enumeration would have collapsed — all still get built, because
nothing is enumerated and then filtered.

- **One line is one test case, named after the line.** The `testing-option` is the
  path as written, less the braces: `dicommisioned-false.isInHoursEmergency-false.2.ref-number.1.24352`.
  So the workbook column, the Connect test case name and the line in this file are all
  the same string, and a failing row is looked up by pasting it back here.
- **Say nothing about paths and every path is generated**, named by the labels of
  [What gets generated](#what-gets-generated) — whether the key is left out, the whole
  values file is, or the list is emptied to `[]`. That is the default and nothing about
  it has changed: writing paths down is what narrows a flow to the calls you asked for,
  so writing none is asking for all of them.
- **Case does not matter**, and `*` and `#` may be written either way: `1.*` is the
  path where the caller pressed star.
- **A stretch every line repeats can be written down once** under `journeys` and named
  with `@`: see [A stretch of a call, written down once](#a-stretch-of-a-call-written-down-once).
- **`MAX_TEST_CASES` (200) is the number of lines that are followed**, and the lines
  past it are skipped with a warning.

### A path is the steps of one call, in the order the call makes them

A label is not that order. What a declared value decided is appended to it after the
walk and the hours result is prepended, so the call where the caller presses `2`,
types a reference number, presses `1` and is looked up comes out labelled
`2.1.AUTH123456.dicommisioned-false.isInHoursEmergency-false` — the two attribute
checks last, though they happened first, and the digits typed nowhere at all. A path
is written the way the call happens instead:

```json
{
  "paths": [
    "dicommisioned-false.isInHoursEmergency-false.2.{ref-number}.ref-number-24680.1.AUTH123456"
  ]
}
```

Read left to right, that is: the decommissioned check saw `false`, the in-hours
emergency check saw `false`, the caller pressed `2`, typed their reference number, the
check on that number read `24680`, the caller pressed `1` to confirm, and the lookup
answered `AUTH123456`. One test case is built for it.

- **Each "Check contact attributes" or "Check contact data" block is written as the
  value it read.** `24352` is the block reading `24352`, and `unset` the one reading
  nothing. Write it under the name of what was read (`auth_number-24352`,
  `dicommisioned-false`, `auth_number-unset`) or as the value on its own where that
  value belongs to one block only (`AUTH123456`) — both are read the same way. A check
  is always written out like this and never put in braces: the flow decided it, not the
  caller. **This is also what puts the value in force**, so writing `24680` at the block
  that compares reference numbers is how the rest of the call gets `24680` — see
  [The value a path names at a check block](#the-value-a-path-names-at-a-check-block).
- **Each menu is `Timeout`, `Default`, or the key pressed or intent matched** (`2`,
  `star`, `bs-sales`) — `Timeout` where the caller lets it time out and `Default` where
  they press something unoffered.
- **Each "Store customer input" block is what was typed** — the number `stored_input`
  declares — or `Timeout`/`Default`.
- **A failing invocation is the function's name and `-error`**,
  `rsa-get-cust-ref-cdk-error`.
- **A step in braces stands in for one step the caller decided and you do not want to
  write out.** Put the step's own name in the braces — `{ref-number}` above is the
  digits typed at the block whose input ends up in `ref-number`, which is the name
  `stored_input` declares them under. A flow that asks for two numbers therefore has a
  way of saying which is which, rather than counting dots. The name **on its own** does
  the same thing, which is what makes a generated test case name go straight back into
  `paths`: `2.ref-number.1` follows the same call as `2.{ref-number}.1`.
  - **Braces are never a check block.** A flow often checks the attribute an input
    block just filled, so `ref-number` is the name of two steps of the same call: the
    typing and the check. The typing is `{ref-number}`, the check is written out as the
    value it read — `ref-number-24680`, or `24680` — and that is what tells them apart.
    Braced, the name is only ever the typing.
  - `{}`, and the words that are nobody's name — `{anything}`, `{any}`, `{value}`,
    `{input}`, `{custinput}`, `{customer_input}`, `{digits}` — stand in for any value
    the caller gave.
  - Either way it stands in for a *value*, so it is not `Timeout` or `Default` — those
    are the caller giving no value at all, and are written out when they are meant.
- **Braces *inside* a step are the value something else in this file declares**, which
  is how a check block on a number the caller typed is written without repeating the
  number: `ref-number-{ref-number}` is `ref-number-24680` when `stored_input` says
  `{"ref-number": "24680"}`. `stored_input` is looked in first and `external` second, and
  a key with a list of values gives the first of the list — so
  `auth_number-{auth_number}` is the first number that key declares. Change the
  declaration and every line referring to it changes with it.
  - The substitution is logged, once per step: `The path "…" reads "{ref-number}" in the
    step "ref-number-{ref-number}" as "24680"`.
  - A name nothing declares **fails the upload** and lists the names that are declared,
    rather than testing a call where the block read the word `{ref-number}` — which is
    what a value nothing matches makes of it.
  - The whole-step wildcards are not values, so `ref-number-{any}` is a mistake and says
    so. Braces alone are a step; braces inside a step are a value.
- **The hours check is not a step of the call**, because a test case sets the hours
  result rather than the call deciding it. Write `OutOfHour` anywhere in the line — the
  front reads best — to have the call made on a closed day. It stays in the name.

### The steps a path leaves out

A path says what matters about a call and leaves the rest alone, so a block it says
nothing about **takes the obvious answer**: a check reads the value it already has and
goes the way that goes, a menu presses its first option, an input block types the
number `stored_input` declares. That is how one line can be a whole call without
spelling out every prompt in it.

Every one of those is an assumption about a call somebody wrote down deliberately, so
it is said out loud, once per block, in the generator's log
(`/aws/lambda/rsa-flow-test-cases-gen-cdk`) — with the step to write into the line to
decide it instead:

```
BM-Test-IaC-Flow block 8c1f… is on the path "2.{ref-number}.1", which says nothing about it,
so it read $.Attributes.auth_number as "24352" and went the way that goes. Write
"auth_number-24352" into the path, where the call reaches it, to say otherwise.
```

So the shortest useful line is a single step (`2` is "press 2 and let the flow take it
from there"), and a line grows a step at a time as the warnings say what it is leaving
to chance.

### The value a path names at a check block

`external` is where the values a block compares against are declared, and a **list**
is the several values a block can be answered with:

```json
{
  "external": { "auth_number": ["24352", "24680", "AUTH123456"] },
  "paths": ["2.{ref-number}.1.24680"]
}
```

A list does not fan out into a test case per value here — the path says which value is
in force. The line above is the call where the lookup answered `24680`, and the way to
test the other two is a line each. A path that says nothing about the block gets the
**first** value of the list, and warns that it did.

Where the value is one the file already declares, the line can name the declaration
instead of the value — `auth_number-{auth_number}` for the first of that list, or
`ref-number-{ref-number}` for the digits `stored_input` says the caller typed — so the
number lives in one place.

Written as `<what-was-read>-<value>`, the value need not be one of the declared ones or
one of the block's conditions at all: `auth_number-unset` is the function answering
nothing, and any other value is the branch Connect takes when none of the conditions
match. That is what a list is for — the list is what the block *can* read, and the
lines are the calls worth making.

### A stretch of a call, written down once

Ten paths that all walk through the same module are ten copies of that module's steps,
and a module that changes is then ten lines to find and edit. Write the stretch down
once under a name, and say the name where it goes:

```json
{
  "journeys": {
    "front": "dicommisioned-false.isInHoursEmergency-false.2.{ref-number}",
    "popia": "1.yes"
  },
  "paths": [
    "@front.1.24352",
    "@front.1.24680",
    "@front.timeout",
    "@popia.1.1"
  ]
}
```

Nothing about this is particular to a module — any stretch written more than once can be
named. A journey may be a dotted line or a list of steps (`["2", "{ref-number}"]`), and
it may be built out of other journeys (`"sales": "@front.1"`); a journey that goes
through itself fails the upload rather than being followed forever.

`@name` is expanded **before** the path is followed, so what gets followed is the whole
call, step by step, exactly as if it had been written out — and a step the journey leaves
out gets the obvious answer in the usual way. Nothing else changes: still one test case
per line of `paths`.

**The test case keeps the short name** (`front.1.24352`), because that is the line that
asked for it. Which means the name goes straight back into `paths` and follows the same
call: the bare name is read as the journey too, and the generator says when it read a
step that way. The `@` is there to be explicit, and to fail loudly — `@nothing.1` names
the journeys the file does write down rather than looking for a step called `nothing`.

A journey name has to be one no step could be, so a name that is a menu option (`"2"`),
a dotted stretch of its own, or a step in its own right (`Timeout`, `Default`, `InHour`)
is refused. And a journey goes where a step goes: `ref-number-@front` is refused too,
because a journey is steps rather than part of one.

### A path the flow does not take

A line that the flow parts company with **fails the upload** and says where it parted
company, rather than writing a config short of a test case:

```
The path "2.1.timeout" is not a path BM-Test-IaC-Flow takes: "2.1" was followed, as far as
BM-Test-IaC-Flow block f4a55daa-…, and then nothing asked for "timeout". The call it followed
instead went dicommisioned-false.isInHoursEmergency-false.2.24680.1.AUTH123456 and ended
having ended with EndFlowExecution. A path is the steps of one call in the order the call
makes them: what the caller presses at each menu ("2"), what they type at an input block
("{ref-number}"), and what each "Check contact attributes" block read, written out as the
value it read ("dicommisioned-false").
```

The call it followed instead is the useful part: it is the path that *should* have been
written, so correcting a line is usually pasting that string over it and changing the
one step that was meant to differ. Two mistakes get their own advice instead of the
general note: a braced name that only a check block goes by (`"{auth_number}" is what a
"Check contact attributes" block read, and a path writes that out as
"auth_number-<value>"`) and a braced name nobody typed on that call, which lists the
names that were typed.

The config and the test cases already in Connect are left exactly as they are when a
line fails, so a mistake here never takes down a suite that was working.

A line that *is* followed but reaches the end of the flow without a prompt to assert is
skipped with a warning naming it (`Path OutOfHour reaches EndFlowExecution without a
prompt this test case could assert - skipping it`), because there is nothing for a test
case to check. If every line ends that way the upload fails rather than writing an
empty config.

Removing a line and re-uploading the values file **deletes the test case it built**:
the loader removes the items its config no longer holds, and the table stream deletes
them from Connect. So the instance ends up with the paths written here and nothing
else, and the results workbook stops collecting rows for the rest.

**A menu tree cannot be followed** — it has no blocks to consult, only options — so
`paths` still picks from the paths it enumerates there, matching whole dot-separated
segments of a label, and the generator warns that it did. Export the flow from Amazon
Connect to have a path followed.

## Voice menus

A DTMF menu says what to press, so the flow itself is enough to generate a test
case. A voice menu (`ConnectParticipantWithLexBot`) branches on **Lex intent
names**, which are not something a caller can say — saying `bs-sales` out loud
would land on the no-match branch. So the phrase that reaches each branch is read
off the bot the block names, the same way a queue named rather than identified is
read off the instance:

1. `DescribeBotAlias` on the block's `LexV2Bot.AliasArn` → the bot, its version
   and its locale (`LEX_LOCALE_ID`, `en_US`, for an alias whose own locale
   settings do not say).
2. `ListIntents` → the id of each intent the flow branches on.
3. `DescribeIntent` → its sample utterances, of which the first one a caller
   could say verbatim is used. A sample with a slot placeholder
   (`book a {RoomType} room`) is only used if there is no plainer one, with the
   braces stripped.

The intent name still *labels* the test case — it is what the flow branches on —
but what the test case sends is the phrase. `BM-Test-Voice-IaC-Flow` is a real
export of a voice flow and needs nothing but the export itself.

**An intent with no sample utterance is skipped**, with a warning naming it, and
so is a bot the generator cannot read. Guessing would generate a test case that
fails for a reason that has nothing to do with the flow. Either add a sample
utterance to the intent on the bot, or say so in the definition:

```json
"utterances": { "bs-sales": "put me through to sales please" }
```

which also **outranks** the bot's samples for that intent — the bot may have
several, and this names the one to test with. Keyed by intent name, so it applies
whichever bot the block hands the caller to.

`defaults.no_match_utterance` changes what the `Default` test case says, if the
built-in phrase (`NO_MATCH_UTTERANCE` on the generator function) happens to be
something one of your bots matches:

```json
"defaults": { "no_match_utterance": "wibble wobble" }
```

`defaults.customer_queue_flow` does the same for hold messages: it names the flow
to read them from where the flow under test sets no `CustomerQueue` event hook,
outranking `DEFAULT_CUSTOMER_QUEUE_FLOW` on the generator function. Bundle that
flow under `"flows"` to use a copy that is not published yet; otherwise it is read
off the instance by name.

```json
"defaults": { "customer_queue_flow": "RSA customer queue" }
```

Both of those, like every other default, can live in `<FlowName>.values.json`
instead — see [Defaults, in the definition or in the values file](#defaults-in-the-definition-or-in-the-values-file).

One thing a voice menu does differently, worth knowing when reading the
generated test cases: a `GetParticipantInput` block's default transition *is* its
no-match path, but a Lex block's default transition is its **error** branch —
what the flow does when the bot itself fails, which no caller behaviour reaches.
The generator does not treat it as a no-match branch, so nothing asserts an error
the flow never actually shows a caller.

## Out of hours

A test case mocks the hours-of-operation check with one value, so covering both
sides means generating the flow twice. The generator does that on its own: the
open side, plus **a second pass with the check mocked as closed** whenever the
flow does something different when it is closed. Those test cases are labelled
`OutOfHour`, or `OutOfHour.1.2` where the closed branch is behind menu options,
so they never collide with the open ones.

Only the paths that actually reach the check are walked twice. A menu option
that hangs up before the flow ever looks at the hours plays out identically
either way, so it stays a single test case.

The closed side comes from the definition itself: for a Connect export it is the
`False` / `OutOfHours` branch of the `CheckHoursOfOperation` block, and for a
menu tree it is the `out_of_hours` block. If a Connect flow's closed branch
lands on the same action as its open branch, nothing is generated for it — there
would be nothing different to assert.

`hours_of_operation_results` controls this, if the automatic behaviour is not
what you want:

| Value | Generated |
| --- | --- |
| omitted, or `"InHour"` | the open side, plus the closed side if the flow branches |
| `"OutOfHour"` | only the closed side |
| `"both"` | both sides, whether or not the flow branches |
| `["InHour"]` | exactly what is listed — the way to switch the extra pass off |

It reads as `"defaults": { "hours_of_operation_results": "OutOfHour" }` in the
definition, or in the values file beside it — see below.

## Defaults, in the definition or in the values file

Everything under `defaults` can be written in `<FlowName>.values.json` instead of
in the definition, and what the values file says **wins**:

```json
{
  "defaults": {
    "hours_of_operation": "RSA Business Hours",
    "hours_of_operation_results": ["InHour", "OutOfHour"],
    "caller_number": "+271234567890",
    "customer_queue_flow": "RSA customer queue",
    "no_match_utterance": "wibble wobble"
  },
  "external": { "customerType": "gold" },
  "stored_input": { "ref-number": "24680" }
}
```

Same reason `stored_input` lives there: a Connect export is re-exported from the
console every time the flow changes, and a `defaults` block added to that export
by hand goes with it. The values file is hand-written and stays, so it is the
place to say something about a flow that has to survive the next export.

| | |
| --- | --- |
| `hours_of_operation` | which hours resource to mock where the flow names none it can read — step 5 of [the list below](#where-the-queue-and-the-hours-of-operation-come-from). A name, an id or an ARN. |
| `hours_of_operation_results` | which results to generate the flow for, per [Out of hours](#out-of-hours). A list is the exact set. |
| `caller_number` | the number the test case calls from, over `DEFAULT_CALLER_NUMBER` |
| `customer_queue_flow` | where hold messages are read from, over `DEFAULT_CUSTOMER_QUEUE_FLOW` |
| `no_match_utterance` | what the `Default` test case says at a voice menu |

Those five are the whole list; anything else under `defaults` is not a default,
and the generator says which name it ignored. A default written **on its own** at
the top of the values file — `"hours_of_operation": "..."` with no `defaults`
around it — is read as the default it plainly is rather than as an
`$.External.hours_of_operation` nobody sets, and warns; `defaults` wins over the
same name written loose.

`hours_of_operation` here is a **fallback, not an override**: the hours a
`CheckHoursOfOperation` block names itself still win, because Connect matches the
mock on the hours resource and mocking a resource the flow never checks would
leave the real check to decide the call. It is for the flow whose check the
generator cannot read — one inside a module this instance will not hand over, or
a flow that checks hours nowhere at all.

## Values a Lambda returns

**The function is never mocked.** An execution overrides the hours-of-operation
check and nothing else, so an `Invoke AWS Lambda function` block invokes the real
function and the contact branches on what it really answers. That is the point: a
test case passing is evidence the function returned what the flow needs.

What the flow export cannot say is what that answer *should* be — Connect puts it in
`$.External.<key>` for the rest of the flow to play back or branch on, and nothing in
the JSON says what goes in there. Declare the expected answer in a sidecar beside the
definition:

```
flow-definition/BM-Test-IaC-Flow.json          the flow
flow-definition/BM-Test-IaC-Flow.values.json   what its Lambdas are expected to answer
```

```json
{
  "external": {
    "customerType": "gold",
    "balance": "R1 250.00"
  }
}
```

One answer per key is all this is for. Which *branches* get covered is not decided
here — every branch of every block that compares an answer gets a test case whatever
this file says, because the values that decide those blocks are written on the blocks.
See [Covering every branch of a check-attributes block](#covering-every-branch-of-a-check-attributes-block)
for what that means when only one of those branches can be taken on the day.

⚠️ **Upload this file too, not just the definition.** With no declared answer there is
no primary one to walk, so every branch value is a guess of equal standing: for
`BM-Test-IaC-Flow` that is 48 combinations, past the 32 of `MAX_EXTERNAL_VARIANTS`, and
the fallback walks each value once — eight arbitrary sets. Most of them decommission the
number, which transfers straight out of the flow, so the menu is never reached and the
run produces **11 test cases instead of 65**. That is what a thin upload looks like: not
an error, just far fewer paths, every one of them named for a flag rather than a digit.

It is a separate file on purpose: a Connect export is re-exported from the console
every time the flow changes, and anything added to it by hand goes with it. The
sidecar stays. (A menu tree, which is hand-written, can carry the same object
under `"external"` inline; the sidecar wins where both exist.)

The same file also carries `stored_input`, for the other thing an export cannot
say — what a caller types at a `Store customer input` block. See
[What the caller types at a "Store customer input" block](#what-the-caller-types-at-a-store-customer-input-block).
And `defaults`, for the hours of operation to mock and the number to call from,
which an export can carry but does not keep: see
[Defaults, in the definition or in the values file](#defaults-in-the-definition-or-in-the-values-file).
And `paths`, with the `journeys` its lines are built out of:
[Writing down which paths get a test case](#writing-down-which-paths-get-a-test-case).

Two things then happen, and neither of them touches the invocation:

- **The value is asserted.** A prompt that plays `$.External.balance` back
  asserts `R1 250.00`. Without the declaration there is nothing to assert, and a
  prompt that is *only* the value is left out of the test case altogether — the
  generator warns when it drops one.
- **The branch it takes is the one walked.** A `Check contact attributes` block
  comparing that key is followed down the branch the declared value matches, and the
  prompts of that branch are what the test case asserts.

So a declared value is an **expectation, not an input**. If the function answers
`R1 250.00` the test case passes; if it answers something else, the prompt does not
match — and where the answer decides a branch, the contact goes somewhere else
entirely and the test case fails on the first prompt it does not hear. Either way the
failure is the function not returning what the flow was built for, which is the check
this suite is for.

**Which keys need declaring: the ones a prompt plays back.** A key the flow only
*branches* on can be left out of the file altogether — its values are read off the
blocks that compare them. `BM-Test-IaC-Flow` declares six keys and needs three:
`agentWording`, `inHourEmergencyMessage` and `outOfHourEmergencyMessage` are spoken,
while `dicommisioned`, `isInHoursEmergency` and `isOutOfHoursEmergency` are only ever
compared, and dropping them generates the same 63 test cases asserting the same
prompts. Leaving them in costs nothing either.

**A key may declare a list of values, and is then covered value by value**, one test
case each, named for the value: `1.gold` and `1.standard`. A value that names nothing
on its own — a flag, a number — is prefixed with its key instead, so a flow branching
on two flags gives `isInHoursEmergency-true` rather than a test case called `true`
with nothing to say which flag it was. A list is rarely worth writing: a value a
block branches on is already covered without it, so the reason to list values is to
assert several different things a *prompt* plays back.

Where `paths` is written, a list is read the other way round: it is the values a block
can be answered with, and each *line* says which one is in force on that call, so
nothing fans out. See
[The value a path names at a check block](#the-value-a-path-names-at-a-check-block).

Those labels are ordered by key name, not by the order the sidecar lists its keys —
the label is part of the `testing-option` sort key the results are read by, so adding
a key to the file cannot rename every other key's test cases.

Only the paths that actually read a key are generated once per value — a menu
option that never reaches the Lambda hears the same thing whatever it would have
answered, so it stays a single test case. That holds even though a real flow does
not branch on `$.External` directly: it copies every answer into contact
attributes in one `Set contact attributes` block and branches on
`$.Attributes.<name>` many blocks later. The generator remembers which key each
attribute's value came from, however many blocks it is copied through, so reading
the attribute counts as reading the key and nothing else does. Several keys with
several values each multiply, and the cross product is capped by
`MAX_EXTERNAL_VARIANTS` (32) with a warning when it bites. That cap is on how many
times the flow is *walked*, not on how many test cases come out: because a path is
only generated once per value of the keys it actually reads, several flags each
covered both ways is a large cross product and a much smaller number of executions.
`MAX_TEST_CASES` (200) is what bounds the executions.

A value may be written as JSON rather than as text — `"dicommisioned": false`,
`"retries": 3` — and is read as the string. A Connect contact attribute is always
text, so `false` is exactly what a `Check contact attributes` block compares
against; writing it unquoted is not a mistake to report.

Declared or not, a `Compare` or `Check contact attributes` block comparing
`$.External.customerType` is followed to the branch the value being answered really
matches, so a declared answer never has a test case asserting a call the flow would
not make.

### Covering every branch of a check-attributes block

**Every branch of every block that compares an answer is a test case, and nothing has
to ask for it.** A `Check contact attributes` block is a list of values and where each
one goes, and that list *is* the test cases — so the values are read off the block
and each is answered once, whether or not the sidecar mentions the key at all. A flow
checking `isInHoursEmergency` for `true` and `false` gets a test case for each, plus
one for the branch neither takes, from a sidecar that says nothing about it.

Declaring stays worth doing for what a prompt *plays back*: nothing but the sidecar
can say that `$.External.agentWording` is `banker`, so nothing else can assert the
words around it. It no longer decides which branches are covered.

A block comparing an attribute has one more branch than it has conditions: the one
Connect takes when **none** of them match. Nothing the function can answer with takes
that branch — what takes it is the function not answering at all, because an attribute
set from a key the response left out is empty and equals none of the conditions. That
branch is covered too, named `isInHoursEmergency-unset`: it asserts the prompts of the
"no matching condition" branch, so it passes when the function really does leave that
key out of its response. Writing `null` in the sidecar asks for the same thing
explicitly and is still read:

```json
{
  "external": {
    "isInHoursEmergency": ["false", "true", null]
  }
}
```

Two conditions leading to the same block are the same call, so a block whose
"no matching condition" transition points where its `true` condition points has two
branches to cover, not three, and no `-unset` test case is generated for it.

**Only one of those branches can pass on any given run, and that is expected.** The
execution invokes the real function, so a check on `isInHoursEmergency` goes down
exactly one branch — whichever the function answered for. The test case built for that
branch passes; the ones built for the other branches hear a prompt they were not
expecting and fail. `BM-Test-IaC-Flow` generates 63 test cases and, with its functions
answering as they do today, around 26 of them are consistent with those answers — the
other 37 are the branches today's answers do not take: `dicommisioned-true`, both
emergency flags set, `auth_number` unset or answering a different reference, and the
three `…-error` cases below.

Read the suite as a set, not as a scoreboard: the test case that passes tells you which
branch the functions are steering callers down, and *that* is what you are checking
against what the flow was meant to do. The rest are there so that when the answer
changes — a flag flipped, an emergency declared — the test case for the new branch is
already written and turns green without anyone regenerating anything.

Two kinds of branch are **reported rather than covered**, because nothing can be read
off the block that is certain to take them:

- **A comparison no single value inverts.** `Equals`, `Text equals`, `Number equals`,
  `Text starts with`, `Text ends with` and `Text contains` each name a value that
  takes the branch. `Number greater than 1000` does not: answering `1000` does not
  take it, and answering `1001` is a guess about a flow this cannot read. Declare a
  value for that key to cover it.
- **An attribute no Lambda answer reaches.** A block branching on something set from
  the caller's number, a Lex slot or a queue name has no answer a test case could
  seed, so its branches are named in the report instead.

`COVER_BRANCH_VALUES=false` on the generator Lambda — or `coverBranchValues: false` in
a call to `generateTestCases` — turns the fan-out off, pinning every block to whatever
the sidecar declared and reporting the rest. The only reason to reach for it is a flow
with more branches than the instance wants executions.

**A branch that plays nothing is not a test case, and is reported instead.** A
decommissioned number is hung up on in silence: the flow reaches its own
`End flow / Resume` block without a prompt. There is nothing to hear and nothing an
execution can watch for, and Connect will not take a test case that only says where the
flow ended — `CreateTestCase` answers:

```
400 InvalidTestCaseException: Invalid test case content
InvalidEventProblem(observationIdentifier=flow_ended, reason=Invalid action type for
  FlowActionStarted event)
```

Only four action types are observable — `InvokeLambdaFunction`,
`CheckHoursOfOperation`, `TransferContactToQueue`, `ConnectParticipantWithLexBot` —
and `EndFlowExecution` is not one of them. So that path is skipped and named in the
report:

```
Path OutOfHour.dicommisioned-false.isOutOfHoursEmergency-true reaches EndFlowExecution
without a prompt this test case could assert - skipping it.
```

Giving the branch a prompt is what turns it into a test case. A prompt that plays
nothing but an attribute the flow never set counts as no prompt: a *Set contact
attributes* block earlier on that branch makes it assertable and the path appears.

When the walk reaches a branching block and no test case ever takes one of its
branches, the generator says which block, which branch, and what would cover it. That
warning is the only place the gap is visible — the generated test cases are named for
the paths that exist, and this is about the one that does not:

```
BM-Test-IaC-Flow block 2e230810 branches on $.Attributes.isInHoursEmergency and
2 of its 3 branches were never taken: "Equals true", "no matching condition".
```

With the fan-out on, that report is about the two kinds of branch above — a range, or
an attribute no answer reaches. `BM-Test-IaC-Flow` reports nothing.

Uploading or deleting a `.values.json` regenerates the flow it belongs to from the
definition, which has not moved — the flow is still there, so its test cases are not
torn down wholesale. What the regenerated config no longer holds does go, though:
that is what makes a changed list of
[paths](#writing-down-which-paths-get-a-test-case) take effect, and it is also why
deleting a sidecar leaves a flow with the handful of test cases its definition alone
can produce. A sidecar uploaded before its flow is ignored with a note, and picked up
when the flow arrives.

A block's function is named from its `LambdaFunctionARN` parameter, falling back to
the display name in the metadata beside the block. That name is only ever used to
*label* a test case, so a flow that sets its ARN dynamically and leaves neither is
covered exactly like any other — the same branches, the same assertions. The one thing
it cannot have is the failure test case, which has nothing to be named after; the
generator says which block.

### A flow that invokes more than one function

Nothing needs to say which function answers which key. The sidecar is one flat object
because it is only ever read as *what the flow should be told*, never sent to anything:
each function is invoked for real and answers for itself, and a key is asserted where
the flow plays it back regardless of which invocation produced it.

```json
{
  "external": {
    "agentWording": "consultants",
    "dicommisioned": "false",
    "isInHoursEmergency": "false",
    "isOutOfHoursEmergency": "false",
    "inHourEmergencyMessage": "Please note that our line are having problems today...",
    "outOfHourEmergencyMessage": "Please note that our line are having problems today...",
    "auth_number": "24680"
  }
}
```

`BM-Test-IaC-Flow` invokes `rsa-call-config-cdk` for the six config keys and
`rsa-get-cust-ref-cdk` for `auth_number`; the file above covers both, and would cover a
third function tomorrow by gaining its keys. If a key comes back from a different
function than you expected, the assertion still holds — what it is checking is that the
flow heard the right value at the right point, not who said it.

### A Lambda invoked asynchronously

An `AWS Lambda function` block set to **Asynchronous** does not answer where it is
called: the contact carries on, a `Wait` block holds the call until the invocation
returns, and a second `AWS Lambda function` block set to **Load Lambda result** picks
the answer up into `$.External`. `BM-Test-IaC-Flow` looks up a sales reference that
way — invoke `rsa-get-cust-ref-cdk`, wait up to five seconds, load, copy
`$.External.auth_number` into an attribute, then branch on it three ways.

**Nothing extra goes in the sidecar for this.** The three chain blocks are read off
the definition:

- **The invocation runs for real**, exactly as a synchronous one does, so what the load
  block reads back into `$.External` is what the function actually returned. Whether
  the wait is interrupted or times out is up to the function too.
- **The wait is followed down its Lambda branch**, not its `NextAction`. That matters:
  the console writes `NextAction` as the branch for a wait that *ended with nothing*,
  so a walk that followed it would end every one of these test cases on the flow's
  "Something went wrong, Goodbye" and assert nothing about the answer. The branch is
  found by the event it listens for, so renaming it in the console changes nothing.
- **The load block's own branches** — its error and `InProgress` exits — are the
  branch it takes when the answer is not there. The test cases that assert the answer
  go the other way, and the one that asserts its absence is
  [the failure test case](#the-function-that-never-answers). In `BM-Test-IaC-Flow`
  those exits lead where the wait's own "nothing came back" branch leads, so the
  failure test case asserts the same prompts either way.

What comes out for the sales branch of `BM-Test-IaC-Flow` is one test case per value
the `Compare` block after the load names, from a sidecar that never mentions
`auth_number`:

```
2.1.AUTH123456          … "We have found your reference number, please hold…"  → BM-Test-Sales-IaC
2.1.auth_number-24680   … "We have found your reference number, please hold…"  → BM-Test-Sales-IaC
2.1.auth_number-24352   … "We have found your reference number, please hold…"  → a different queue
2.1.auth_number-unset   … "Please check your reference number and try again"
```

`auth_number` pushes that flow's answer sets to 48, over the `MAX_EXTERNAL_VARIANTS`
cap of 32. Past the cap the answers are no longer crossed with each other: instead
every value is walked **once**, against the first value of every other key. Eight sets
instead of forty-eight, and all four `auth_number` answers are among them — including
`-unset`, which crossing them and cutting the list off at 32 dropped, taking the
"no matching condition" branch it covers with it. What is lost instead is a branch that
needs *two* particular answers together, and `reportUncoveredBranches` names any such
branch. Raise the cap on the generator Lambda to cross every combination again.

**A wait waiting for an invocation nothing made** takes the branch the flow gives a
wait that came back with nothing, and the generator says which block: that is a flow
to look at, not a test case to trust. A `Wait` block used for anything else — a
callback, a case update — is followed the way any other block is.

### The function that never answers

Every `AWS Lambda function` block also has an **Error** branch, and where that branch
goes somewhere of its own it gets a test case of its own, named for the function that
failed:

```
2.1.rsa-get-cust-ref-cdk-error   … "Something went wrong, Goodbye"
```

⚠️ **This test case is red while the function is healthy, and that is the whole of what
it can be.** Nothing makes the invocation fail — the execution calls the real function —
so the test case asserts the apology, hears the flow carry on instead, and fails. It
turns green when `rsa-get-cust-ref-cdk` is genuinely down, throwing, or too slow to
answer inside the block's limit. Read it as a monitor of the failure path, not as a
test that should be passing. The generator warns for each block it emits one for.

Three things decide whether it exists at all, and nothing goes in the sidecar for any
of them:

- **The failure has to go somewhere else.** Both invoke blocks in `BM-Test-IaC-Flow`
  wire their `Error` branch straight back into their `Success` one, so neither earns a
  synchronous failure test case — there would be nothing different to assert.
- **The function has to be named on the block.** A dynamic ARN leaves nothing to name
  the test case after; the branch is reported instead.
- **One invocation fails per test case.** A flow invoking three functions gets three
  failure test cases, not eight — each one is about that function being down.

An asynchronous invoke block has no failure of its own to take: it hands the contact on
whatever the function does, and the `Wait` block further down is what finds out. So for
`BM-Test-IaC-Flow` the failure test case is the wait ending with nothing — the branch
the success test cases deliberately do not take.

Deleting these test cases is a one-line change in the generator if a permanently red
result is worse than an uncovered branch; ask and it will be made.

## What the caller types at a "Store customer input" block

A `Store customer input` block — a `Get customer input` block with `StoreInput`
set — is not a menu. It offers no options, so there is nothing to branch on: it
waits for digits, keeps them, and the rest of the flow reads them back as
`$.StoredCustomerInput`, usually after one `Set contact attributes` block has
copied them into an attribute of its own:

```
Please enter your reference number for the sale     ← the block
sales_number = $.StoredCustomerInput                ← kept
Your sales number entered is $.Attributes.sales_number.
Please press 1 to confirm or press 2 to enter the number again.
```

The test case **sends digits there**, and what it sends comes off the definition:

```json
"stored_input": { "sales_number": "5551234" }
```

Keyed by the name of an attribute the block's value is copied into — the readable
form, and what the generator asks for when nothing is declared — or by the
block's own identifier out of the export, for a value no attribute is given:

```json
"stored_input": { "42d869d3-f6e3-4f60-aac3-be2079efcfdb": "5551234" }
```

A bare string is every input block in the flow at once, which is all a flow with
one of them needs:

```json
"stored_input": "5551234"
```

It goes in the definition, or in the `<FlowName>.values.json` sidecar beside it
(the sidecar wins, key by key, the same way it does for `external`):

```json
{
  "external": { "agentWording": "banker" },
  "stored_input": { "sales_number": "5551234" }
}
```

**The sidecar is the place to put it.** A definition is re-exported from the Connect
console every time the flow changes, and the export has no room for a key nobody
added, so one written into the definition comes back missing — the generator falls
back to `1234`, so a `paths` line naming the declared digits stops being a path the
flow takes and fails the upload. In the sidecar it survives every re-export.

The same name is what a path calls the step: `"paths": ["…{sales_number}…"]`. See
[A path is the steps of one call](#a-path-is-the-steps-of-one-call-in-the-order-the-call-makes-them).

**Undeclared, the generator types `1234`** — trimmed to the block's own maximum
digits where that is shorter — and says so, once per block, naming the
declaration to write. Digits it made up are not the guess a Lambda answer is:
here the test case *is* the caller, so whatever it types is what the flow really
receives, and a prompt playing it back is asserted word for word either way:

```
prompt_4  Please enter your reference number for the sale        ← sends 1234
prompt_5  Your sales number entered is 1234.
          Please press 1 to confirm or press 2 to enter the number again.
```

What made-up digits cannot get right is a block that **branches** on them — a
`Compare` on `$.Attributes.sales_number` looking for a reference number that
exists. Declaring the value is how that branch gets taken deliberately; the
warning says as much.

A `Get customer input` block can both offer options and store what was pressed.
Then the option pressed *is* the stored input, and each branch remembers its own
digit, so nothing needs declaring for it.

A prompt that reads `$.StoredCustomerInput` on a path where no input block was
reached has nothing to assert, and is left out of the test case with a warning
naming it — the same treatment as an undeclared `$.External` value.

### The caller who types nothing, and the caller who types the wrong number

Typing the number the flow wants is one of three things a caller does at an input
block, and the block gets a test case for each. The other two are the `Timeout`
and `Default` test cases, and **neither of them types the declared number** — that
is the whole point of them:

| Test case | What it sends | What `$.StoredCustomerInput` then holds |
| --- | --- | --- |
| the number | the declared value, `5551234` | `5551234` |
| `Timeout` | **nothing at all** — no `Action` on that block | `Timeout` |
| `Default` | a number the flow was not asking for, `9999` | `9999` |

Both continue down the block's ordinary exit unless the flow wires them
elsewhere, because neither is an error there. The block's own documentation is
explicit about the first: *"When a call includes no customer input, the contact
takes the Success branch. The Stored customer input system attribute holds a value
of `Timeout`."* And a number the block does not validate is simply accepted. So
the confirmation prompt after it is asserted reading back what the caller really
left behind:

```
timeout_4  Please enter your reference number for the sale        ← sends nothing
timeout_5  Your sales number entered is Timeout.
           Please press 1 to confirm or press 2 to enter the number again.

default_4  Please enter your reference number for the sale        ← sends 9999
default_5  Your sales number entered is 9999.
           Please press 1 to confirm or press 2 to enter the number again.
```

That is a flow worth looking at rather than a test case worth arguing with: a
flow that reads the number back without checking it for `Timeout` first reads the
word "Timeout" out to the caller, and the test case says so.

The wrong number is **built from digits the wanted one does not use** — `9999`
against `5551234`, `0000` against `9876` — so a `Compare` block looking for the
real reference number cannot match it by accident. It is trimmed to the block's
maximum digits the same way the declared value is.

The exit belongs to **the block it happens at**. A `Timeout` at a menu further
down the flow is still reached by entering the number, so that test case types it:

```
menu_4     Please enter your reference number for the sale        ← sends 5551234
timeout_5  Your sales number entered is 5551234.
           Please press 1 to confirm or press 2 to enter the number again.
```

And a flow that loops back for a second go at the number gets the same caller
doing the same thing again — two goes typing nothing, on one test case — not three
more paths branching off the second go.

## Where the queue and the hours of operation come from

**Out of the flow, per branch.** Neither is configured anywhere, because a flow
already says which queue each menu option routes to and which hours it checks —
and those differ from branch to branch. `BM-Test-IaC-Flow` routes its four menu
options to four different queues, so it generates four test cases each asserting
a different transfer target:

| Test case | Menu option | Queue block | Queue |
| --- | --- | --- | --- |
| `1.1` | technical → WiFi | `UpdateContactTargetQueue` | `BM-Test-Technical-Wifi-IaC` |
| `1.2` | technical → laptop | `UpdateContactTargetQueue` | `14b354a2-…` |
| `2` | Sales | `UpdateContactTargetQueue` | `BM-Test-Sales-IaC` |
| `3` | general queries | `UpdateContactTargetQueue` | `BM-Test-General-IaC` |

**Queue** — the queue is *asserted* by the test case, so only the flow can
supply it:
1. `TransferContactToQueue` / `UpdateContactTargetQueue` / `SetWorkingQueue`
   parameters, wherever the branch passes through one — including inside a module
   or a transferred-to flow. The queue in effect when the branch reaches
   `TransferContactToQueue` is the one asserted.
2. The queue in the metadata beside that block — which is all the designer
   leaves behind when the queue is set from a name rather than an id. The
   parameter wins where both are present, since the metadata only carries the
   display name the designer showed.

There is **no configured fallback**. A branch whose flow names no queue — or
names one that is no longer on the instance — ends its test case on the last
prompt instead of on a queue transfer, and the generator logs why. Asserting a
transfer to some default queue would make the test case lie about the flow.

**"Set working queue" is not a transfer.** It names the queue; `Transfer to
queue` is what puts the caller in it — the block's own documentation says a
contact not already in a queue needs both, in that order. So a branch that sets
the queue, names the flow to play on hold, and then reaches `End flow / Resume`
queues nobody: the caller hears whatever the last prompt said and the contact
ends there. Those test cases assert no queue and no hold message, because
neither happens, and the generator names the block:

```
BM-Test-IaC-Flow block 955026ff-… ends the flow on a branch that set the working
queue (6b1b6ba4-…) at 6b396c31-… and named a customer queue flow, but nothing on
the branch transfers the contact - so the caller is never queued, and the test
case asserts no check_queue and no hold message. Wire that branch into a
"Transfer to queue" block to have both.
```

That is a flow to fix rather than a test case to work around — a branch whose
prompt says "please hold while we transfer you" and then hangs up is a bug the
test case is right to not paper over. A queue set only so a
`CheckHoursOfOperation` block can read it, on a branch that then disconnects, is
a different thing and is left alone.

**Hours of operation** — these are *mocked* rather than asserted, so the branch
only needs a value to mock:
1. The `HoursOfOperationId` on the `CheckHoursOfOperation` block the branch
   walks through, or the name in the metadata beside it.
2. **The hours of the queue that block checks.** A `CheckHoursOfOperation` block
   with no id checks the hours of whichever queue is set at that point in the
   flow, so the generator calls `DescribeQueue` on that queue and mocks its
   hours.
   A check inside a **module** or a transferred-to flow counts: the walk steps
   into those, reads the block's own `HoursOfOperationId` there, and mocks it —
   Connect matches the mock on the hours resource rather than on a block, so it
   fires wherever the check happens. The module does not have to be bundled; it
   is read off the instance.
3. **The hours of whichever queue the branch targets**, even where the branch
   passes no check block at all.
4. Whatever the flow's other branches resolved — a branch that disconnects
   before reaching the check has no hours of its own.
5. `defaults.hours_of_operation`, in the values file beside the definition or in
   the bundle itself — the values file wins. A menu tree needs this, since it has
   no `CheckHoursOfOperation` block to read. See
   [Defaults, in the definition or in the values file](#defaults-in-the-definition-or-in-the-values-file).
6. `DEFAULT_HOURS_OF_OPERATION` on the generator, which covers every flow at
   once. See below.

A queue or hours referred to **by name** is resolved to its id against the
Connect instance (`ListQueues` / `ListHoursOfOperations`), so
`"queue": "BasicQueue"` works in either format. ARNs are accepted anywhere an id
is; only the id is kept. Generation fails if no hours of operation can be found
at all, since the test case has to mock the check.

### An account-wide default, for a flow that names hours nowhere

Steps 1–4 cover any flow that checks hours or queues at all, which is nearly all
of them. What is left is a flow that does neither — one that only plays prompts
and hangs up, or one whose check lives in a module this instance will not hand
over. Such a flow generates *nothing*: every test case needs an hours id, because
the mock is keyed on the resource.

Set one for the whole generator rather than per definition:

```bash
cdk deploy -c hours-of-operation="RSA Business Hours"
# or an id, or an ARN
cdk deploy -c hours-of-operation=4605e369-8882-44d8-a3e9-069bb7fb7120
```

That becomes `DEFAULT_HOURS_OF_OPERATION` on `rsa-flow-test-cases-gen-cdk`. A
name is resolved off the instance once per upload.

**It is a floor, not an override.** Every step above beats it, so a flow whose
branches check two different sets of hours still generates two different mocks.
Leave the context out and the generator fails loudly on a flow that names no
hours, which is the better default: mocking hours a flow has nothing to do with
makes the test case say something untrue about it. Set it when you would rather
have coverage of the prompts than a failed upload.

The one value a flow can never supply is who calls in. That lives in
`cdk.json`, not in the definition:

```json
"context": {
  "caller-number": "+1234567890"
}
```

The stack passes it to the generator as `DEFAULT_CALLER_NUMBER`, and `cdk deploy
-c caller-number=+271234567890` overrides it for a one-off deploy. Synth fails if
it is missing, since every test case executes as a call from that number.

A single flow can still override it for its own test cases, if one flow needs to
be tested from a different number — in its definition, or in its values file:

```json
"defaults": { "caller_number": "+271234567890" }
```

`BM-Test-IaC-Flow.json` and `BM-Test-Voice-IaC-Flow.json` set nothing at all —
they are purely the exports.

## Format 1 — Amazon Connect exports

The flow, plus every module it invokes and every flow it transfers to. **This is
the format to use**: the test cases then follow the flow that is actually
deployed, and every queue and the hours of operation come out of its blocks.
`BM-Test-IaC-Flow.json` is a real export, produced by:

```bash
aws connect describe-contact-flow \
  --instance-id <instance> --contact-flow-id <flow> --region <region> \
  --query 'ContactFlow.Content' --output text
```

```json
{
  "flow": { "Version": "2019-10-30", "StartAction": "...", "Actions": [ ... ] },
  "modules": { "Compliance-Module": { "Actions": [ ... ] } },
  "flows":   { "Sales-Flow":        { "Actions": [ ... ] } }
}
```

`BM-Test-IaC-Flow.json` is exactly that and nothing more — a single `flow` key.
The flow name is its file name, the queues and hours are its blocks, and the
caller number is in `cdk.json`.

- `flow` may also be spelled `main_flow`, `contact_flow` or `content`, and a
  single export with no dependencies can be uploaded on its own.
- Each value may be the export object **or** the JSON string that
  `DescribeContactFlow` returns in `Content`, so a bundle assembled straight
  from API responses works unchanged.
- Dependencies are matched to the `TransferToFlow` / `InvokeFlowModule`
  reference by the flow id, the full ARN, or the display name Connect stores in
  the flow's metadata. **Key them by flow/module name or by id** and they will
  resolve. `flows`, `modules`, `flow_modules` and `dependencies` are all read,
  so a flat `"dependencies"` map holding both kinds is fine.
- A missing dependency is a warning, not a failure: a missing transfer target
  ends that path, a missing module is stepped over. Check the generator's
  CloudWatch logs after uploading.

Action types that shape the test case:

| Type | Effect |
| --- | --- |
| `MessageParticipant`, `PlayPrompt` | a prompt to assert on |
| `GetParticipantInput` | a DTMF menu — one test case per condition, plus `Timeout` and `Default`; with `StoreInput` and no conditions it is a data entry block instead, answered with [what the definition says the caller types](#what-the-caller-types-at-a-store-customer-input-block) — and with `Timeout` and `Default` test cases of its own, which [type nothing and type the wrong number](#the-caller-who-types-nothing-and-the-caller-who-types-the-wrong-number) |
| `ConnectParticipantWithLexBot` | a voice menu — one test case per intent, said as a phrase read off the bot; its default transition is the bot's error branch, not its no-match one |
| `CheckHoursOfOperation` | supplies the hours to mock, or the queue to read them off; its closed branch becomes the out-of-hours test cases |
| `InvokeLambdaFunction` | left to run for real — the walk only reads [the values declared for the flow](#values-a-lambda-returns) to know what to *assert*; set to **Asynchronous** it also marks the answer as on its way, for the `Wait` block that holds the call until it lands. A synchronous one whose `Error` branch goes somewhere of its own also earns [a test case where the function never answers](#the-function-that-never-answers) |
| `Wait` | if it is waiting for an asynchronous invocation this path made, followed down that branch — the invocation answers, so the wait is interrupted — and its other branch becomes [the test case where that answer never comes](#the-function-that-never-answers); otherwise followed the way any other block is |
| `LoadLambdaFunctionResult` | reads the function's answer into `$.External`, so a later `Compare` or `Check contact attributes` block branches on it; its error and `InProgress` exits are the branches for an answer that is not there |
| `UpdateContactTargetQueue`, `SetWorkingQueue` | remembers the queue for this branch only — [it is not a transfer](#where-the-queue-and-the-hours-of-operation-come-from) |
| `UpdateContactAttributes` | remembers what it set, for this branch only, so a later prompt that plays the attribute back can be asserted |
| `TransferContactToQueue` | asserts `check_queue` against the queue remembered on that branch, then whatever the customer queue flow plays after it |
| `TransferToFlow` | continues into that flow's definition |
| `InvokeFlowModule` | walks into the module, then returns after it |
| `DisconnectParticipant`, `EndFlowExecution` | ends the path |
| `Loop` | followed round: each `ContinueLooping` pass re-prompts and is answered the same way, then `DoneLooping` ends the retry |
| anything else | followed through; it changes nothing the caller hears |

Prompts are cleaned up before they are asserted on: SSML markup is stripped, the
line breaks a prompt is laid out over become [one line](#what-gets-generated),
and because a prompt with an interpolated attribute (`$.Attributes.FirstName`) can
never match literally, only the longest literal run of the text is kept. The
test case matches on inclusion, so a substring is enough.

**An attribute the flow set itself is put back first.** A `Set contact
attributes` block writing `ooo_message` means a later prompt of
`$.Attributes.ooo_message` is asserted as the sentence that block set — which is
the only way such a prompt is asserted at all, since read literally it has no
text in it and the block would be dropped. Both `$.Attributes.name` and
`$.Attributes['name']` are recognised, and the value is remembered per branch, so
two menu options that set the same attribute differently assert differently. It
carries into modules, transferred-to flows and the customer queue flow, the same
way the attribute stays on the contact.

Anything else stays dynamic and falls back to the longest literal run: an
attribute filled in by a Lambda, one set to another interpolated value
(`"$.External.desk"`), one set with `TargetContact: "Related"` (a different
contact), or one set on a branch this path did not take. Where that leaves a
prompt with no literal text at all, the prompt is left out of the test case and
the generator logs which attributes it was waiting on — once per block.

## Format 2 — menu tree

A short hand-authored shape for when there is no export to hand, or for stubbing
a flow that has not been built yet. Prefer format 1 for a flow that exists:
a menu tree is a description of a flow rather than the flow itself, so its queues
and hours are whatever you typed rather than whatever is deployed.

```json
{
  "defaults": { "hours_of_operation": "4605e369-..." },
  "prompts": ["Welcome to the test flow", "This call may be recorded."],
  "start": "main_menu",
  "out_of_hours": {
    "prompts": ["Sorry, our offices are currently closed. Goodbye."],
    "disconnect": true
  },
  "menus": {
    "main_menu": {
      "prompt": "Press one for technical issues.\nPress two for Sales.",
      "options": {
        "1": "technical_menu",
        "2": "queue:73e9d156-a62d-4471-9cbb-af126df78a1d",
        "*": "repeat"
      }
    },
    "technical_menu": {
      "prompt": "Press one for WiFi issues, press two for laptop issues.",
      "options": {
        "1": { "prompts": ["Sending you our WiFi guide."], "disconnect": true },
        "2": "queue:73e9d156-a62d-4471-9cbb-af126df78a1d"
      }
    }
  }
}
```

- `defaults.hours_of_operation` is **required** here — inline as shown, or in the
  values file beside it — unless the generator was deployed with
  `-c hours-of-operation=…`. A menu tree has no
  `CheckHoursOfOperation` block to read the hours off, and the test case has to
  mock the check with something, so generation fails without either.
- `prompts` are the announcements played before the first menu. `start` defaults
  to the first menu listed.
- `out_of_hours` is what callers hear instead of the menus when the flow is
  closed, in the same shape as a menu option (`prompts` plus `disconnect` or
  `queue`). It becomes the `OutOfHour` test case. Leave it out and no closed test
  case is generated, since there is nothing to assert.
- An option is either a shorthand string — `"<menu name>"`, `"queue:<id>"`,
  `"disconnect"`, `"repeat"` (not tested) — or an object with any of
  `menu`, `queue`, `disconnect`, `prompts` (extra announcements played after the
  digit) and `input_type` (defaults to `DtmfInput`, or `Utterance` for a
  non-DTMF option value).

## Changing or removing a definition

Re-uploading a definition overwrites its generated config, and each affected
test case is deleted and recreated in Connect. **A menu option you delete takes its
test case with it**: the loader removes the DynamoDB items its config no longer
holds, and the stream deletes each of them from Connect. The same is true of a
[path](#writing-down-which-paths-get-a-test-case) whose line is taken out of the
values file. So the config is
the whole truth about what a flow has — there is nothing to purge by hand, and no
need to delete a definition and upload it again to clear stale test cases.

**Deleting `flow-definition/<FlowName>.json` deletes that flow's test cases in
Connect.** The whole line unwinds: the generated config goes, the DynamoDB items
go with it, and the generator deletes every test case in Connect named
`<FlowName>:…` — which is all of them, since `universal-test-cases-gen` names
each one `<flow-name>:<testing-option>`. The colon is what stops one flow's name
reaching another's, so a `BM-Test-IaC-Flow-Copy` keeps its test cases when
`BM-Test-IaC-Flow` is deleted.

Deleting by name rather than leaving it to the DynamoDB stream is deliberate: the
stream only deletes a test case some item pointed at, so a test case created by hand,
or left over from a config that was cleaned up before the loader removed what it
dropped, would otherwise outlive the flow definition entirely.

The build never deletes anything — `aws s3 sync` runs without `--delete`
precisely so that removing a file from git cannot tear down test cases as a side
effect of a deploy. Deleting a definition is a deliberate act: delete the object
from S3, or from this folder and then from S3.

Purging an old *version* of a definition is not a deletion. The bucket is
versioned, so `ObjectRemoved` fires then too — the generator re-checks the key
and keeps everything if the definition is still live.

Neither is deleting a key that never named a flow. A sub-folder key, or the
zero-byte `flow-definition/<FlowName>/` placeholder the console leaves behind
when you delete a folder's contents, generated nothing — so its removal is logged
and ignored. **The placeholder in particular must not be read as `<FlowName>`**,
or clearing out the old layout would delete the live flow's test cases; the
`.json` on the end is what tells a definition from a folder.
