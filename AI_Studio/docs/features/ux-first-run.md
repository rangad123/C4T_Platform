# First run: three starts, a plan before anything is created, live progress, next steps

What changed for the tester (UX-E, round 15).

## For the tester

- **Welcome.** A new project (first visit, or New project) starts at three equal cards: **Explore my app** (a URL; says it uses the AI model and that nothing is created or run until you say so), **Record a test** (opens the recorder for a new project with the address filled in) and **Start from tests I have** (import chooser, or an empty Test scripts list to write a test by hand). Without an AI model the first card says so and links to Settings; the other two work. **Choose what to test first** opens the Explore page (the address and one optional **Focus**) with a Back button. Which checks run is set by the project's testing agents, and sign-in details, API access and the OpenAPI document are kept on the project's Requirements tab.
- **Plan before creation.** Exploring now stops after planning. The project's Overview shows "We found 4 pages and 2 API endpoints, with 1 form. We will create about 18 tests: ..." with **Create the tests**, **Discard the plan** and an **Edit the plan** section (a checkbox per kind of test, and per test idea under Journeys). The numbers change as you edit; Create sends exactly the choice shown. Nothing is generated or run before Create.
- **During creation.** "Creating your tests": phase list in words, elapsed time, a live list of the tests ("Passing", "Failing", "Waiting", the same per-test list as the Runs page) and **Stop exploring** with UX-A's honest wording (created tests are kept).
- **Ready.** A **Next steps** list on the Overview: open a test that is not passing, run the tests again, set a schedule, add sign-in details (only when the application has a sign-in page), connect a runner. Each step ticks itself from real data (a validate run exists, a schedule exists, saved sign-in details, a connected runner); nothing is stored for the list. It disappears when everything that applies is done.
- A project that has a plan and no tests reads "Plan ready" (project list, badge), not "Test suite ready".

## Platform: plan mode (additive)

- `POST /api/projects/:id/test-generation` accepts `plan: true`: the job explores, understands and plans (discovery, understanding, planning phases), then stops. Generation and validation are `skipped`, no test or run summary is created, and the plan is stored as an artifact of kind `plan` (`plan.json`: the application model, the planned test ideas, the access survey results; never credentials or page text beyond what the application model already holds). The job ends COMPLETED (or PARTIALLY_COMPLETED with the reason, e.g. no AI model so no journeys); it FAILS when the plan holds nothing that could be created.
- `GET /api/projects/:id/plans/:jobId` reads the plan: `found`, `about`, `pages`, `ideas`, `families` (each kind of test with a plain sentence, `count`, `on`, and for speed and access checks a web/API `split`), `total`, `warnings`, `used`. Counts come from the same generators the creation phase calls with the same limits, so they equal the tests created; journeys are the exception (each is tried in a real browser, a few may not work out; the UI says so).
- `POST .../plans/:jobId/create` starts a normal generation job that begins from the stored plan (`options.fromPlan`; event `plan_reused`): nothing is explored or planned again. The body may switch kinds of check on or off and leave test ideas out (`excludeIdeas`), and may narrow `targets` but never widen them. Refused: unknown idea, nothing selected, plan already used (409), plan removed or pruned (410), other project (404).
- `DELETE .../plans/:jobId` forgets a plan.
- Callers that do not pass `plan` (CLI, MCP, schedules, imports) behave exactly as before. A plan-only job is not counted as a run (no run summary, trends or alerts).

## Decisions and limits

- The form's first submit now always makes a plan (the one-click path stays two clicks to a plan plus one to create). Links with a project or an address (`#/new?project=` / `?url=`, Explore again) go straight to the Explore page.
- A plan is not a promise: pages behind a sign-in are not in it unless sign-in details are saved on the Requirements tab; the plan says so when it found a sign-in page.
- A plan is kept until used, discarded, or removed by the storage policy (then the page says it is gone and offers Explore again). There is no automatic expiry.
- Changing sign-in details, test accounts or data-changing tests means exploring again; the plan editor only chooses among what was found.
- Not verified: a very large site's plan page (page list is capped at 50, shown with a note).
