# Hand-written tests: take over, write, share helpers

## What it does for you

Generated tests are driven by steps (a canonical spec), and the platform writes their scripts. Sometimes you want to write the script yourself. You can:

- **Take over** a generated web or API test: its script becomes the thing you edit and run. The steps are kept in the background (archived), and you can go back to the generated version at any time.
- **Write a test from scratch** in the editor.
- **Import tests from Git** (see `git-import.md`): each file becomes a hand-written test with a link to where it came from.
- **Share code** between tests in **helpers**: small modules a script imports as `./helpers/<name>`.

Every save is a **version**: you can see the history, compare, and put an older version back (that makes a new version; history is never rewritten).

Hand-written tests are real tests. They run in the same places as generated ones: validation, schedules, runbooks, deploy triggers, browser and screen-size checks, environments, quarantine, issues, evidence and runner agents. What changes is the list under "What stops" below.

## What stops for a hand-written test

Taking a test over shows this list before you confirm (`GET /api/tests/:id/take-over` returns it, worded for the test):

- the steps no longer drive anything (the script is the only source of truth)
- repair suggestions (locator healing) stop for that test, and automatic repair during validation is not attempted: a failing hand-written test fails as it is
- changes to shared elements (object repository) no longer apply to it
- rewriting it from a plain-English description, and "Make shared" suggestions, no longer apply
- the spec export leaves it out (its script goes out with the project download, together with the helpers it imports)

Everything that only **runs** the script still works. Restoring the generated version discards the custom script as the current one (it stays in the history), renders the archived spec again, and the test is a generated test again. Tests written from scratch or imported from Git have no archived spec, so they cannot be restored.

## Safety: two layers, and which one is the real one

Hand-written scripts are arbitrary code. Two things stand between a script and the machine:

1. **The static guard** (`src/engine/custom/guard.ts`) reads the script with TypeScript's parser and refuses what it can recognise. It is a guard against **accidents and obvious escapes, not a security boundary.**
2. **The run policy** (`src/platform/custom-policy.ts`) decides **where** a hand-written script may run. This is the boundary:
   - on the platform host only when `ALLOW_CUSTOM_SCRIPTS=true` is set in the platform's environment **and an `API_KEY` is set** (default off; it means running user-supplied code on the server for everyone who holds the key), or
   - on a runner agent whose owner started it with `--allow-custom-scripts` (see `runner-agent-setup.md`).

### The guard's rules

A script or helper is checked when it is saved, when you type (debounced check), right before it runs on the platform (`runScripts` checks again), and again by a runner agent. With an error nothing is saved or run; warnings are saved.

| Refused (error) | Rule id |
|---|---|
| imports other than `@playwright/test`, `@axe-core/playwright` and `./helpers/<name>` (static, `export ... from`, `import x = require`, type imports) | `import`, `import-helper`, `require` |
| `require`, dynamic `import()`, `import.meta`, `declare module "x"` | `require`, `dynamic-import`, `import-meta`, `declare-module` |
| `eval`, `new Function`, `Function(...)`, `.constructor`, `__proto__` | `eval`, `function-constructor`, `forbidden-property` |
| `constructor`, `__proto__`, `getPrototypeOf`, `setPrototypeOf`, `getOwnPropertyDescriptor(s)` and the other names that lead to the Function constructor, also when the name is held in a `const` (or any later `x = "..."`) of the same file, joined (`+`, template, `[...].join("")`, `.concat`, `.toLowerCase()`, `a ? "x" : "y"`), written as a destructuring key (`const { constructor: F } = fn`, `{ ["constructor"]: F }`, `{ [k]: F }`) or reached through element access; a destructuring key that is computed at run time is refused too | `forbidden-property` |
| `Reflect` | `reflection` |
| `globalThis`, `global`, `module` | `global` |
| `process` other than reading `process.env.BASE_URL`, `API_BASE_URL`, `TEST_*`, `API_*` and the platform's `AITP_EVIDENCE`/`AITP_CLEANUP`/`AITP_CREATED_DIR` (also by element access with a literal, by destructuring, and `process.env[prefix + "_USERNAME"]` for named test accounts) | `process`, `env` |
| file paths that leave the test's folder in `screenshot`, `pdf`, `attach`, `storageState` (call or option), `saveAs`, `setInputFiles` (every argument), `routeFromHAR`, and the `path` / `dir` / `storageState` options of `newContext`, `newPage`, `launch`, `test.use` (absolute, drive letters, `~`, `..`), also when the path is held in a constant or joined from constants | `path-escape` |
| `executablePath`, `userDataDir`, `launchServer`, `launchPersistentContext`, `connectOverCDP`, `chromium.connect` | `launch-option`, `launch` |
| the `args` and `env` options of `launch`, `newContext`, `connect` and `test.use`, and anything inside `launchOptions` (they hand commands and variables to the program that starts the browser) | `launch-option` |
| `_electron`, `electron`, `android`: as named imports, and as members of a namespace import (`import * as pw`, `pw.android`, `pw["_electron"]`, a copy of the namespace, destructuring it); `._electron` on anything | `import` |
| `page.goto` of a `file:`, `view-source:`, `chrome:`, `chrome-extension:` or `filesystem:` address (also held in a constant) | `goto-scheme` |
| a syntax error (reported with line and column), control characters, text-direction overrides outside strings | `syntax`, `control-character` |
| a script over 200 KB, a helper over 100 KB, over 20 000 lines; a syntax tree with more than 250 000 parts or nested more than 500 levels deep (one very long expression); a failure inside the check itself | `size`, `lines`, `complexity`, `unreadable` |

Warnings: a `while (true)` / `for (;;)` without `await`, `break` or `return` (`infinite-loop`), `__dirname` / `__filename` (`path-building`), and a `./helpers/<name>` the project does not have yet (`helper-missing`).

Code the platform itself pastes into generated scripts (the evidence helper, the load-check helper) is recognised by exact text and passes, so any generated test can be taken over as it is. Change a character of it and it is checked like everything else.

The check cannot hang the server or fail loudly. It uses the parser's own diagnostics (not a full compile, whose cost grew with the square of a long expression: one 120 KB line of `1+1+...` once took 49 s), refuses a tree that is too big or too deep before walking it, caps the findings it lists (the verdict is never cut), and turns any failure inside it into one error diagnostic. A script of 190 KB of ordinary code is checked in well under a second. A **Git import** adds a budget of 8 MB of script text per import (files beyond it are listed as left out, with the reason) and gives the server a breath between files; a **backup restore** also yields between hand-written tests.

### What the guard cannot see (honest list)

The guard works on the syntax tree and folds constant strings within one file (`"req" + "uire"`, template literals, `const` names, joins, unicode escapes; comments are ignored). It **cannot** see:

- a value computed at run time: a property name assembled by a function or from data (`Array.from("rotcurtsnoc").reverse().join("")`, `String.fromCharCode(...)`, a value read from a file, the page or the network), or a name set in another file (a helper);
- which of several values a name has where it is used (all values the file ever gives a name are checked, which can refuse harmless code, never the other way);
- anything a library does with an option it is allowed to receive (Playwright options other than the ones listed above);
- the value of `this` in a plain function, and other reflection that is not a name in the list (`Object.entries`, `Symbol`, proxies);
- **what a script sends over the network.** The platform's address guard (`BLOCK_PRIVATE_TARGETS`, `net-guard.ts`) applies to addresses the platform itself is given. Node-side `fetch(...)`, `request.newContext`, `page.request` and `page.goto` of any `http(s)` address run from the machine that runs the test and are **not** covered, so a hand-written script can reach internal addresses (for example cloud metadata) from there;
- what a hand-written script does with the environment values it may read (`TEST_*`, `API_*`: it can send them anywhere).

Treat the guard as a safety net for honest mistakes. The reason the run policy exists is exactly that a determined author can get past the guard.

**`ALLOW_CUSTOM_SCRIPTS` must not be enabled for authors you do not trust.** With it on, anyone who can save a script (everyone who holds the API key) can run code on the platform's machine; the guard slows down an accident, not an attacker. For untrusted authors use no host switch at all, and run hand-written tests only on a runner agent that sits where you accept that risk (a throw-away machine, a container, or a network that cannot reach anything internal).

## The run policy in detail

One decision function (`customRunDecision`) is used everywhere:

| Where the project runs | Allowed when |
|---|---|
| the platform host | `ALLOW_CUSTOM_SCRIPTS=true` **and** an `API_KEY`. Without a key the switch is ignored: anyone who can reach the port could otherwise run code on the machine without signing in. The platform prints a warning when it starts, `GET /api/config` answers `customScripts: { platform: false, reason }`, and a refused run says why in its sentence. |
| a runner agent | at least one eligible agent reports `customScripts: true` (started with `--allow-custom-scripts`). The host switch does not widen what an agent allows. |

Layers (outside in), so forgetting one still fails closed:

1. **Job creation** (`Repo.createJob`, so a person, a schedule, a trigger and a runbook all pass through it): a job that includes a hand-written test where it may not run is refused with a plain **409** before any job exists: "This project has hand-written tests. Start your runner agent with --allow-custom-scripts, or set ALLOW_CUSTOM_SCRIPTS=true on the server." (worded for host or agent). This covers validation, browser and screen-size checks and environment runs.
2. **Schedules, deploy triggers and runbooks** leave hand-written tests out when they may not run; the rest still runs, and the job records "N hand-written tests were not run" with the reason.
3. **The job's executor** is wrapped when the run includes hand-written tests: on this machine it refuses them (an error result, nothing started) unless the host agreed.
4. **`runScripts`** refuses a script marked custom unless the caller said this machine agrees, and checks each such script and helper with the guard again. A **runner agent** applies the same rules with its own flag: it never reports the capability without `--allow-custom-scripts`, the platform never offers it a hand-written task otherwise, and the agent refuses one anyway ("This task has hand-written scripts, and this agent was not started with --allow-custom-scripts").

Saving a script never runs it by itself. When running is not allowed, `PUT /script` still saves, answers `jobId: null` with the plain reason, and the test stays "Not validated".

## Helpers

Up to 20 per project, each at most 100 KB, named with lower-case letters, digits and hyphens (`^[a-z][a-z0-9-]{0,40}$`; Windows device names such as `con` are refused). A script imports `./helpers/login-steps`; a helper imports another as `./other`. Helpers pass the same guard. For a run, only the helpers a script imports (through other helpers up to three levels) are written to `helpers/<name>.ts` in the run folder, so a helper cannot be written outside that folder whatever its name.

Changing a helper marks every test that imports it (directly or through other helpers) as not validated and queues one validation run, like a change to a shared element does. A helper cannot be deleted while a hand-written test imports it (409 listing the tests). A helper belongs to one project: another project cannot see or import it.

## How it is built

| Piece | Where |
|---|---|
| Static guard, syntax check | `src/engine/custom/guard.ts` |
| Helper names, import closure, path safety | `src/engine/custom/helpers.ts` |
| Tables (migration slot 22): `custom_tests`, `custom_script_versions`, `custom_helpers`, `custom_audit`, `git_repos` | `src/platform/custom-script-store.ts` |
| Operations: take over, restore, save, versions, write from scratch, helpers | `src/platform/custom-scripts.ts` |
| Run policy, gate, executor wrapper | `src/platform/custom-policy.ts`, `custom-run.ts`, `custom-run-policy.ts` |
| Routes | `src/platform/routes/custom-scripts.ts` (contract: `.scratch/briefs/CODE-API-SHAPES.md`) |
| Execution | the same `runScripts` path; `ScriptInput.custom`, `ExecutionBatch.helpers`, `ExecutionOptions.allowCustom` |
| Agent | `src/agent/config.ts` (`--allow-custom-scripts`), `capabilities.ts`, `task-runner.ts`; protocol fields `Capabilities.customScripts`, `WireScript.custom`, `TaskOffer.helpers` |

The current script of a hand-written test keeps living in `generated_scripts`, so downloads, backups and runs find it where they always did. `Repo.updateTest` ignores a spec for a hand-written test, so nothing (repair, healing, rewrite, import) can overwrite the archived steps. Versions: the newest 100 are kept per test, version 0 (the generated script) never pruned; saving identical content again does not create a version. Backups include hand-written tests (with their archived spec and versions) and helpers in `helpers.json`; a restore checks every runnable script of a hand-written test, every version of its history and every helper with the guard again and refuses the backup (a plain 400) if one fails. A backup in which two versions of one test have the same number is a plain 400 too, and so is a hand-written test of a framework other than Playwright.

Extra answers beyond the contract: `x-custom-script: true` header on `GET /api/tests/:id/script`; `note` next to `jobId: null`; `revalidating: { tests, jobId, note? }` on a helper change; `capabilities.customScripts` on an agent in the Agents list; `tests` list entries and test detail carry `custom`.

## Limits

- Web and API (Playwright) tests only; mobile and Windows desktop tests cannot be taken over yet, and neither can a test whose framework is not Playwright (for example a web test run through Taqwright): taking over is refused with the reason, and a backup that marks such a test hand-written is refused.
- Bounded history: the newest 100 versions per test (version 0 never pruned), and at most 50 MB of script history per project (beyond that the oldest versions of the project go first; never version 0 and never a test's newest version). The audit trail keeps the newest 1000 rows per project, and so does the log of live sessions.
- A hand-written test is not run on a production environment (what it changes cannot be known beforehand).
- No stored spec for written or imported tests, so no "restore generated" for them.
- The guard needs `typescript` at run time (it is installed with the project's dependencies). If it cannot be loaded, hand-written scripts are refused rather than let through unchecked.
- Not tested: a hand-written script on a Windows-desktop or Android agent (not supported), and agents that are offline while a task waits (the task fails after the usual wait, with the usual message).
