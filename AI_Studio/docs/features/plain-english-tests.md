# Plain-English tests

Describe a test in your own words. The platform opens your application in a real browser, does what you described, keeps the steps that worked, runs the finished test from the start, and stores it like any other test.

## What you do

1. Open a project, go to **Tests**, and choose **Write a test**.
2. Type what the test should do, for example: *Add a product to the cart and check that the total is shown.* Say what to check at the end; that is what makes it a test.
3. Choose **Create and run test**. The dialog shows progress (reading the description, building the test in a real browser, running it). You can close it; the test appears in the list when it is ready.
4. Open the test. Its page shows your sentence under "Written in plain English". Choose **Change the description** to rebuild the same test from new words: same test, same history, a new script version.

If the project has environments (staging and so on), the dialog offers "Build it on". A production environment is refused: building a test means clicking through the site, and production is read-only.

## What you get

| The agent... | The test is stored as |
| --- | --- |
| built the steps, checked the result, and the real run passed | **Validated**, with your sentence as its description and `origin: plain-english` |
| could not finish (for example "the page has no element showing the total") | **Needs review**, with the agent's own explanation as the reason. It is kept, not run, and never green |
| finished, but the application did not behave as described | **Needs review**: "The application did not behave as described: ..." |
| built a test that passed but checks almost nothing (only the page address, a container every page has, or a bare "request succeeded") | **Needs review**: "The test ran and passed, but it checks very little... We have not counted it as validated." |
| built a test that failed its run | the normal outcome of validation, including the repair loop |

Nothing is marked as passing without a real run. A "passed but weak" test has real executions in its history; only its verdict is held back.

## Web and API descriptions

- **Web** (the default): your description becomes one scenario for the same authoring agent that explores applications (`src/engine/web/author.ts`). It records only steps that worked, ends with the assertions it verified, and signs in with the project's stored test account when one exists. The password never appears in the spec: it stays `{{credentials.password}}`.
- **API**: when you pick API, or the sentence names a call ("GET /api/products/1 should return the Blue Mug") or an endpoint the application is known to have, the model only chooses which known operation the sentence is about, the values to send and what the answer should contain. The spec is built from that choice and checked against the known operations, so an operation, method or path that does not exist can never end up in a test. This needs known operations: run an analysis with the API description (OpenAPI) first. Only calls that read (GET, HEAD, OPTIONS) are built unless the project allows tests that change data.

## What is refused, and when

Before any job is created the description is checked; a refusal is an HTTP 422 with a plain reason and nothing is queued:

- paying for something, card details, placing an order;
- deleting accounts or data, and naming a data-changing call (POST, PUT, PATCH, DELETE), while tests that change data are switched off for the project;
- using someone else's password or account, and attacks (brute force, hijacking, injection);
- no AI model set up: "The AI model isn't set up yet..." (422);
- no application address yet (400), unknown or production environment (404 / 422), an API test with no known operations (422).

These rules are word-based and deliberately cautious. They are a first filter, not a security boundary: the authoring agent's own rules (never payment, never destructive actions) still apply, and the test only ever touches the application you configured (outbound addresses go through the same guard as everything else).

## How it works

- `POST /api/projects/:id/plain-tests` with `{ description (3 to 2000 characters), kind?: "web" | "api", environment?, baseUrl? }` answers 202 `{ jobId, kind }`. The job has mode `plain`: it shows in Runs, is cancellable, and follows the one-active-job-per-project rule (409).
- `POST /api/tests/:id/plain-rewrite` with `{ description, environment? }` rebuilds a plain-English test (422 for other tests). If the rebuild cannot be finished the existing test is left exactly as it was and the job reports why.
- Code: `src/engine/authoring/` (`describe.ts` reads the sentence and refuses, `api.ts` turns the model's plan into API steps, `plain.ts` runs the whole thing), `src/platform/plain-run.ts` (environment, sign-in, which test is rebuilt), `src/platform/routes/authoring.ts`, UI in `web/src/features/authoring/`.
- The agent is bounded like an analysis scenario (at most 24 tool steps). No images are sent: AI judgement of screenshots stays an opt-in of its own.
- The sentence and the agent's explanation are stored with the test (`generationMeta.plain`, `explanation`), so a later re-validation can repair the test with its original intent.
- A plain-English job does not count as a run of the suite: it adds no point to trends and raises no alert.

## Limits

- It needs an AI model for the building step. Without one the feature says so and does nothing; it never fabricates a test.
- It is as good as the model and the page. A sentence that is vague about what to check produces a weak test, which is held back as "needs review".
- A test that was kept as "needs review" because it could not be built contains only the steps that worked (or a placeholder request for API descriptions that matched no operation). If someone re-runs it later, the platform treats it like any other test: a pass shows the "weak checks" badge instead of being refused a green.
- One test per description. Several tests in one sentence are not split.
- Mobile apps are not supported. Web and API only.
- The word-based refusal can have false positives (for example a test that only looks at a page called "Pay"); rephrase the description.
