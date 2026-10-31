# Frames, uploads, drag and drop, popups and the test data reset

Real web pages are not one flat document. A payment form sits in an iframe, an avatar is uploaded through a file field, cards are dragged
between lists, terms open in a new window, and tests need the same starting data every time. This feature covers all five, in every place a
test is made: the recorder, the step editor, the text format and the generated script.

## What a tester gets

### Frames (iframes)
- A step's element may be **inside a frame**, found by the frame's `name`, its `title`, or a part of its address (`src` contains the text).
  Frames inside frames are followed up to **3 deep**.
- **Recorder**: clicks, typing, choices, ticks, key presses and the inspector work inside same-origin and cross-origin frames. The step says
  so ("Click the button "Pay" inside a frame ("checkout")"). A frame with no name, title or address, or one nested more than 3 deep, is not
  recorded and the recorder says why.
- **Step editor**: every element field has "Inside a frame" (not in a frame / a frame with this name / with this title / whose address contains).
  A deeper chain the recorder saved is shown and can be removed.
- **Text**: `Click the "Pay" button inside the frame "checkout"`, `inside the frame titled "Card"`, `inside the frame at "pay.example.com/form"`.
  With frames in frames the inner one is written first.
- **Script**: `page.frameLocator('iframe[name="checkout"], frame[name="checkout"]').getByRole("button", { name: "Pay" })`.
- **Exploration**: the explorer also reads the interactive elements of up to 5 frames per page (30 elements each, 2 seconds per frame), with
  the frame chain in the hint the planner sees.

### File uploads and the test files library
- **Library, Test data, Test files**: small files a test uploads (images, PDF, text, CSV, JSON, XML, zip, Office documents, short audio and
  video). At most **5 MB per file, 50 files and 50 MB per project**. Spaces in a name become dashes; a file with the same name is replaced.
  The list says which tests use each file; a used file cannot be removed; names steps use that the library does not have are listed.
- Step **Upload a test file**: `Upload "photo.png" to the "Avatar" field`. The element is either a file input or a button that opens the file
  chooser (the script answers the chooser). The file reaches the run next to the script, on this server or on a runner.
- **Recorder**: when a file is chosen it records an upload step with the file's **name only** (the content never leaves the person's computer)
  and tells the person to add a file of that name to Test files. With several files chosen only the first is kept.
- A run whose file is missing fails on that step with "The test file "x" is not available to this run. Add it under Library, Test data, Test files..." (never a silent pass).

### Drag and drop
- Step **Drag and drop**: `Drag the "Card 1" listitem to the "Done" list`. The script uses Playwright's `dragTo`, which moves the pointer
  the way a person does, so HTML5 drag events (`dragstart`, `dragover`, `drop`) fire.
- **Recorder**: a drag and drop is recorded from the page's HTML5 drag events (the element picked up and the one it was dropped on).

### Popups and new tabs
- A click can **open a popup** (`opensPopup`); later steps marked **in the popup** (`inPopup`) work in that window. Text:
  `Click the "Terms" link and wait for the popup`, then `Click the "Accept" button in the popup`.
- The script waits for the popup while clicking (`const popupOpened = page.waitForEvent("popup")`), and every "in the popup" step runs
  against it; with no popup open the step fails plainly. A newer popup replaces the older one ("the popup" is always the latest).
- Whole-page checks (accessibility, screenshot, page health, speed, input handling, access, AI judgement) work only on the page the test started
  on; the editor and the generator refuse them in a popup.
- **Recorder**: a window the recorded page opens is followed; the click that opened it is marked, and what the person does in it is recorded as
  steps in the popup. Where the popup goes is guarded like the page. A window the page did not open is only noted.

### Test data reset before a run
- **Library, Test data, Reset the test data before a run** (one per place a run goes: the project's own address and each environment that is
  not production): a method (POST, PUT, DELETE, PATCH, GET), an address (a path of the application, or a full address on the same site),
  the expected answer status (default 200), and up to 10 headers whose values are **write-only and stored encrypted**. "Try it now" sends it once.
- Before every **run of existing tests** (a run, a browser and screen-size check, an environment run) the platform sends it once. The Run panel's
  sentence says so: "First the test data is reset (POST /test/reset); if that fails, no test runs."
- If it fails (another status, a timeout after 30 seconds, an address that is refused) the run **stops before any test starts**: the job fails
  with "The test data reset failed: POST /test/reset answered 500; 204 was expected. No test was run, so no result changed." Test statuses and
  history are untouched. The last outcome is shown under the form.
- An exploration and a test built from a sentence do not reset (they make their own data).

## How it works
- Spec (`src/engine/spec/schema.ts`, all optional and additive): `locator.frame` (`[{ by: "name"|"title"|"url", value }]`, outermost first,
  at most 3), actions `upload` (`locator`, `file`) and `drag` (`locator`, `target`), `click.opensPopup`, and `inPopup` on the page steps.
  Steps that use none of these render exactly as before (a unit test checks the script).
- Shared pieces: `src/engine/web/pages.ts` (frame selectors and naming, test-file names, the upload helper source, popup setup, the rules),
  `src/engine/web/frame-elements.ts` (the explorer's bounded frame read). The live interpreter (`src/engine/web/interpreter.ts`) follows
  frames, drags and popups the same way; it uploads only when it is given a test file, otherwise it says upload steps run in test runs.
- Test files travel with the approved screenshots: `RepoSink.loadBaselines` adds each file an upload step needs as `upload--<name>` in the
  run's `__baselines__` folder, which runner agents already download and check by hash, so no protocol change was needed for files. The script's
  `testFile()` looks there.
- Recorder (`src/engine/recorder/*`): the page script now runs in frames too (frames never report page visits), sends `upload` (file names)
  and `drag` (source and drop target candidates) messages; the session works out the frame chain from the frame elements' attributes, follows
  the popup, and refines candidates in the frame they came from. Protocol (`src/agent-protocol/schema.ts`, additive): `RecStepWire.kind` gains
  `upload` and `drag`, and optional `target`, `frame`, `inPopup`, `opensPopup`.
- Storage: migration slot 31 (`src/platform/test-data-reset-store.ts`: `test_files`, `test_data_reset`), files under
  `<project>/_test_files/` in the artifact store. Routes: `src/platform/routes/web-pages.ts`. The reset runs in `src/platform/test-data-reset-run.ts`,
  called at the start of a job in `job-runner.ts`.
- Reset address rule: the resolved address must be on the application's own origin (the environment's for an environment run) or an origin an
  administrator lists in `RESET_ALLOWED_ORIGINS` (comma list), and pass the platform's outbound address guard. Redirects are not followed (they
  could carry the headers elsewhere). The answer's body is never read into a message.

## Limits (what is not covered)
- Upload steps get their files in normal runs (this server or a runner). **Browser and screen-size checks and environment runs do not place test
  files yet**: an upload step fails there with the plain "not available" message.
- The live interpreter (step-by-step sessions, repair replays) does not upload files.
- A frame is found by name, title or address part; a frame that has none of them cannot be targeted (the recorder skips it). A frame selector
  that matches two frames makes the step fail (Playwright is strict); name the frame more precisely.
- Drag and drop relies on Playwright's pointer drag; pages that implement dragging with custom pointer math may still need a hand-written code
  test. The drop target is ranked by the page's own match counts (the platform's double check marks only the dragged element).
- One popup is followed at a time ("the popup" is the latest one). Popups opened by script without a click are followed by the recorder but a
  test needs a click step marked "Opens a popup".
- The reset is one HTTP request with headers and no body; database resets or scripts are not run by the platform. Production environments are never reset.
- Shared elements (`{ ref }`) do not carry a frame in the step; give the shared element itself a frame when it lives in one.
- Not verified here: real third-party payment frames (only a local fixture with nested frames, relative and named), real file choosers of
  headed browsers on a runner, and the reset against a real application.
