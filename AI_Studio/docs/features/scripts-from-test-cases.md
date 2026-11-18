# Test scripts from test cases (web and Android)

In a code-based project the flow is Requirements, then test cases, then test scripts. A **test case** is written: the steps a tester
follows and what should happen at each one, typed **Automated** (a tool can do it) or **Manual** (a person does it). A **test script**
is the runnable test. Each Automated test case gets at most one script, linked to the case and to the case's requirement.

The AI writes the scripts from the cases. It needs an AI model: without one, the card says so before the click ("The AI model
isn’t set up for this project…"), and the person can add their own key under Settings, AI keys, or ask an admin to assign one. Writing scripts needs the
permissions to add tests and to use the AI to write tests in that project (a project viewer does not have them, whatever their
role elsewhere): without them the card is not shown.

## Where

* **Test cases**: the **Generate test scripts using AI** card under the list. It works on the cases chosen in the list, or on all of
  them when none is chosen. This is the only place it is offered; the New test script menu on Test scripts does not repeat it.

The card says first how many scripts will be written and that Manual cases are skipped. At most 20 scripts are made per request; the
page sends the rest in further requests. A phone script is the AI's **draft**: it is not run, and it runs only once someone approves it
(Test scripts, Review). A web script is built and run as a described test is (below), and follows the project's review rules for AI
work the same way.

## What the AI writes

What the AI writes follows the project's platform.

* **Web** (and a project made before round 37 with both web and a phone app): the script is built exactly as **Test scripts, New test
  script, Describe it** builds a test, by the same code (`plainStarter` in `src/platform/routes/authoring.ts`). The case's title, steps
  and expected results become the description; the AI does the steps in a real browser on the application, signs in with the
  project's sign-in (Settings, Sign-in) through `{{credentials.*}}`, keeps only the steps that worked and the checks it saw hold on the
  page, and the script is run once. So a check after signing in is what the application really shows (an "Account" page), never a page
  name guessed from the case ("Dashboard"). Each case is one run, one after the other: when a case's run ends, its test is linked to
  the case and the case's requirements, and the next case's run starts (`src/platform/case-scripts.ts`). The chain stops at a cancel,
  when a run made no test, or when someone starts another run of the project; generating again picks up the cases left. The card
  follows the cases until each has its script. It needs the application address (Settings, General), and runs that can start (tests
  switched on on the server, or a ready runner in runners mode), like Describe it.
* **Android**: a phone test, the same kind of test an imported or explored phone test is (Taqwright). The AI has not seen the app,
  so it finds every button and field by the words on it, its accessibility label, or an empty field's hint text, taken from the
  case. It never invents element ids. The draft's description says so: check the steps on the device before approving it. The test
  is tagged `check-on-device`. It needs the project's Android app (Settings, Mobile app), and Taqwright switched on (Runners,
  Frameworks).
* **iOS only**: not yet. Both entry points say so; write those scripts by hand or import them.

A phone script may use these steps: tap, type into a field, tick or untick, scroll or swipe, scroll a list until an element shows,
wait (at most 10 seconds), and check that an element is shown, hidden, enabled, disabled, or contains a text or value. At most 40
steps. There is no Home button, no Back button and no deep link: whether a Back stays in the app depends on screens the AI has not
seen (Back after a tap that only closed a dialog leaves the app, and the taps after it would work on the launcher or another app).
The person checking the draft on the device adds Back where the test needs it. A tap inside the app can still open another app (an
"open in browser" link, a share sheet); the run brings the app under test back once when that happens. Sign-in uses `{{credentials.username}}` and `{{credentials.password}}`, only as what is typed into a field, never to find an
element or as an expected text. `{{unique}}` gives a fresh value. No other placeholder exists.

## Checks

* What the model answers is data. It is parsed, capped and validated, never executed. A phone answer must be one JSON object in the
  step shapes above. It is then built into a phone test that must pass the spec schema, the "no secrets typed into a test" rule (a
  password must be a placeholder) and the Taqwright generator. Then it is saved through the platform's spec import, so every import
  rule applies. A web script is checked by its run in the browser and the validator, as a described test is.
* A phone answer that does not pass goes back to the model once, with the problems. If the second answer fails too, that case gets no
  script, and the page lists it with the reason. A web case whose run made no test is listed too; its run says why.
* A web case whose words a described test refuses (paying, someone else's account, an attack, deleting data while that is off) is
  skipped with that sentence.
* The case is sent to the model as data between markers, with any markers it contains taken out.
* What the code sets is never left to the model: a case title shorter than a test's title may be (three characters) gets the case's
  ID in front ("TC-004: Go") before the model is asked, and a problem in a field the code sets ends that case at once, without a
  second, paid call.
* Refused before any AI call, and in the dry run too: an AI agent project, a web project without an address, an Android project
  without its app, an iOS-only project, and Taqwright switched off. The page says the same before the click. One request per project writes at a time
  (web: while its runs go on, a second request is refused in plain words).
* The case is checked again right before saving. A case deleted while the AI wrote, or one that got its script meanwhile, gets no
  new script.

## API

`POST /api/projects/:id/manual-cases/generate-scripts` with `{ caseIds?: string[], dryRun?: boolean }` (permissions
`ai_studio.tests.generate` and `ai_studio.tests.write`). The answer is `{ form: "text" | "phone", created: [{ caseId, testId, key }],
skipped: [{ caseId, reason, detail }], eligible?: string[], started?: { jobId, caseIds }, note?: string }`. A web request answers with
`started` (the first case's run and every case queued) and an empty `created`: the scripts are linked to their cases as the runs end. `reason` is `manual`, `has-script`, `not-found`, `later`,
`ai-failed` or `refused`. `note` is present when phone scripts were made, and says they need checking on the device. 409 answers
carry the refusals above in plain words. With no AI model the answer is 422 with `details: { modelMissing: true }`.

## Limits

* The AI has not seen the app, so a phone script's text and labels are the case's words. Where the app uses other words, the step
  fails on the first run: check the draft on the device, then edit or approve it.
* Phone scripts have no DSL form yet (the DSL has web and API steps only).
* A phone script keeps the test case's ID and its requirements as its source, but its origin line reads "Imported from a file". A
  web script's origin is the described test's ("plain-english"), under the Plain English suite, as Describe it makes it.
