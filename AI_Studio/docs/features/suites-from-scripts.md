# Test suites made from test scripts

A test suite is an ordered list of a project's test scripts and how they run (environment, extra browsers, retries, stopping at the first failure). Besides making a suite by hand (**New suite**), there are three ways to make suites from the scripts a project already has. Each suite made this way starts with the usual settings; open it to put its scripts in order or change how it runs.

## From a selection (Test scripts)

On **Test scripts**, choose **Select scripts**, tick the scripts, then **Create suite from selection** in the bar. Name the suite (and optionally say what it is for) and choose **Create suite**: it holds exactly the selected scripts, in the order they were selected, and opens.

`POST /api/projects/:id/test-suites/from-scripts` `{ name, description?, testIds }` → 201 with the suite.

## By requirement (Test suites, Generate suites, no AI)

**Generate suites → By requirement** makes one suite per requirement that has test scripts, named `REQ-1: <its title>`. A requirement's scripts are the scripts made from its written test cases (a case's requirement, and requirements a case is linked to, with the scripts the case points at) and the scripts linked to the requirement directly. Each script is in a requirement's suite once, in key order.

It says first what it will do, and only does it when you choose **Create … suites** (or **Update …**):

- a requirement without a suite gets a new one. If one of your own suites already has that name, the new suite gets a number ("REQ-1: Pay (2)") and yours is left alone;
- a suite made here before is **updated** with the scripts that are **new to its requirement** since the last run, added at the end. Nothing is removed, the order and settings stay, and **a script you took out of the suite is not put back** (the plan says how many stay out);
- when a schedule runs a suite that gets new scripts, the plan names the schedule: its next run includes them;
- requirements without scripts and retired requirements get none (listed under the plan).

A generated suite remembers its requirement (not its name), so it is found again after you rename the suite or change the requirement's reference. Suites you make yourself, and copies of a generated suite, are never changed by it. If you delete a generated suite, the next run makes a new one.

The suite limits apply (50 suites per project, 500 scripts per suite); what does not fit is listed.

`POST /api/projects/:id/test-suites/generate` `{ by: "requirement", dryRun? }` → `{ dryRun, suites: [{ requirementId, ref, title, action: "create" | "add" | "up-to-date", suiteId, name, testIds, adding, keptOut, schedules }], skipped: [{ requirementId, ref, title, reason: "no-scripts" | "retired" | "limit" | "full", detail }], created, updated }`. `dryRun` saves nothing.

## Using AI (Test suites, Generate suites)

**Generate suites → Using AI** asks the project's AI model to propose suites (for example Smoke, Regression, one per feature or area) from the scripts' titles, kinds, types, priorities, areas and requirements. The proposal is shown for you to check: rename suites, remove suites, move scripts between suites or remove them. **Nothing is saved until you choose Save.** Saving is all or none: every name must be free in the project and in the list.

- It needs an AI model. Without one the menu entry says so, and the request answers 422 with a plain sentence; you can add your own key in Settings, AI keys, or ask an admin to assign one. The AI token limit, when reached, is a 409.
- It needs both permissions: using the AI to write tests (`ai_studio.tests.generate`) and changing tests (`ai_studio.tests.write`).
- The model's answer is untrusted: only scripts the model was given count (others are left out and counted), names and descriptions are one line of plain text cut to length, empty suites are dropped, a name given twice gets a number, at most 12 suites (fewer when the project is near its limit). Only the first 300 scripts in key order are sent; the answer says so when there are more. Nothing the model says is run.
- AI usage is metered like the other AI features.

`POST /api/projects/:id/test-suites/propose` `{}` → `{ suites: [{ name, description, testIds, nameTaken }], scripts: [{ id, testId, title, kind, area }], notes, limits }` (saves nothing), then `POST /api/projects/:id/test-suites/batch` `{ suites: [{ name, description?, testIds }] }` → 201 `{ suites }`.

## Access and errors

Making suites needs `ai_studio.tests.write` (the proposal also `ai_studio.tests.generate`). A script id that is not the project's answers 404 and nothing is saved. Saving a batch is one transaction: a failure on any suite saves none of them. Everything that checks suite names or the number of suites (creating, renaming, duplicating, and the three ways above) takes its turn per project, so two saves at once never make two suites with one name; the second waits for the first. One AI proposal per project runs at a time; a second answers 409 until the first has answered.

## Limits

- No new table or column: a generated suite's requirement, and the scripts generation has handled, are kept in the suite's stored browser list (`browsers_json` holds `{ browsers, origin }` for these suites; every other suite keeps the plain list). An older version of the platform reading such a suite sees no extra browsers on it.
- Turn-taking and the one-proposal rule live in the server's memory, so they hold for one API process, which is how the platform runs.
- The AI sees titles and labels, not the steps of each script, so a proposal can group scripts that look alike by name. Check it before saving.
