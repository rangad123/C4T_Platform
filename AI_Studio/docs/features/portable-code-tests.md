# Downloaded tests run anywhere

A test downloaded from the platform runs on the tester's own computer or CI, whatever Node.js, npm, browsers and packages that computer happens to have. The rule is the one of round 17: **do not depend on what the computer has, pin it and ship it.**

## What a tester does

- **Every passing test of a project:** **Tests**, **More actions**, **Export…**, **Download tests** (`GET /api/projects/:id/download`, unchanged route, new contents).
- **One test:** open it, **Code**, **Download ready to run** (`GET /api/tests/:id/download`, new; role: viewer). Works for tests made from steps and for code tests (the shared helpers a code test imports come along).

Then, in the unpacked folder:

```
npm ci
npx playwright install
npx playwright test
```

The README in the folder says the same, which environment variables the tests read (`BASE_URL`, `API_BASE_URL`, the test account's `TEST_USERNAME` and `TEST_PASSWORD`, `API_TOKEN`, ... only the ones the scripts really read), how to set them on macOS/Linux, PowerShell and the Command Prompt, and which versions the folder pins.

## What is in a download

| File | What it is |
|---|---|
| `tests/<suite>/<TEST-ID>.spec.ts` | the scripts (browser, API and Windows desktop tests); a code test's helpers in `tests/<suite>/helpers/` |
| `phone-tests/android/...`, `phone-tests/ios/...` | phone tests, kept out of `tests/` so `npx playwright test` never starts them (before this change they were in `tests/` and broke a plain run) |
| `package.json` | `devDependencies` with **exact** versions: `@playwright/test` always, `@axe-core/playwright` when a script (or a helper) imports it, `@taqwright/taqwright` when there are phone tests; `engines.node`; `npm test` (and `npm run test:phone`) |
| `package-lock.json` | exactly those versions and everything they need (see below) |
| `.nvmrc` | the Node.js major version (`nvm use`) |
| `playwright.config.ts` | the settings the platform runs tests with: 60 s per test, 8 s per expectation, 10 s per action, 30 s per navigation, no retries, a `chromium` project with Desktop Chrome at 1280 x 800, evidence (screenshot, trace, video) only for failures, the list reporter and JUnit XML in `results/junit.xml`, baselines in `tests/__baselines__/`. With desktop tests, a `windows-desktop` project that exists only on Windows |
| `taqwright.config.ts` | phone tests only: an `android` and/or `ios` project, configured with `MOBILE_AVD` / `MOBILE_SIMULATOR`, `MOBILE_APP_PACKAGE`, `MOBILE_APK_PATH`, `MOBILE_UDID` |
| `README.md`, `.gitignore` | the three steps and the settings; `.gitignore` keeps `node_modules/`, `test-results/`, `playwright-report/` and `results/junit.xml` out of Git |
| `manifest.json`, `specs/`, `blocks.json`, `objects.json`, `results/validation-junit.xml` | as before (project download); the one-test download carries `specs/<TEST-ID>.json` for a test made from steps |

The code: `src/platform/portable-export.ts` (`portableFiles`, `exportPath`), `src/platform/routes/portable.ts` (the one-test route), the project route in `src/platform/server.ts` (an anchored change: paths through `exportPath`, the old two-line config and README replaced by `portableFiles`), the UI in `web/src/features/portable/RunnableDownload.tsx` (on the Code tab) and the Export dialog's wording in `web/src/pages/ProjectTests.tsx`.

## Which versions, and the lockfile

The pinned versions are the ones the platform has installed and runs the tests with: they are read from the platform's own `package-lock.json` (`node_modules/<name>` entries). Today that is `@playwright/test` 1.63.0, `@axe-core/playwright` 4.13.0 and `@taqwright/taqwright` 1.1.0; the next `npm ci` of the platform after a version bump changes the downloads with it, nothing to edit by hand.

**How the lockfile is made (no internet needed):** `src/engine/portable/lockfile.ts` `cutLockfile` cuts it out of the platform's `package-lock.json`. Starting from the pinned packages it follows every `dependencies`, `optionalDependencies` and non-optional `peerDependencies` edge the way Node.js resolves them (a package's own `node_modules`, then each enclosing one), and copies each entry it reaches **unchanged** (version, `resolved` download address, `integrity` hash, `engines`, `os`/`cpu`, `bin`, ...) at the **same place** in the tree. It writes a fresh root entry whose `devDependencies` equal the download's `package.json`, marks every entry `dev` (the download has only devDependencies) and `optional` where only optional edges reach it, as npm marks them. Because the cut is a subset of a tree npm itself built and verified, every edge resolves to the same version npm chose. A pin that is not in the platform's lockfile at that exact version, a required dependency that is missing, a linked package or a lockfile older than version 2 stops the cut (`LockCutError`) instead of producing a lockfile `npm ci` would reject. Sizes today: Playwright alone 3 packages, with axe 5, with Taqwright about 160.

The Node.js version the download asks for is the highest lower bound in the pinned packages' own `engines.node` (Playwright 1.63 says `>=20`, Taqwright `>=24`), raised to 20.16 when a script uses the API load check's helper (`process.getBuiltinModule`). The runner's own Node.js rule does not apply here.

An installation of the platform without a `package-lock.json` (not the case for the repository or the Docker image) still gives a working download: package.json without pins for the packages it could not read, no lockfile, `npm install` instead of `npm ci` in the README, and a plain note saying so.

## The supported Playwright range

- **Oldest: 1.42.1.** Every generated test passes its tags as test details (`test(title, { tag: [...] }, body)`), which Playwright introduced in 1.42; 1.42.1 is that line's last patch. Nothing else the generators emit is newer (the next newest are `locator.pressSequentially`, 1.38, used by input checks, and `locator.or`, 1.33, used by access checks).
- **Newest tested: the pinned version** (1.63.0 today), which is also what the platform runs.

Code tests written by hand are outside the range: their authors may use any API of the version they were written against, which is the pinned one.

**The check that keeps it that way** (`src/engine/portable/playwright-apis.ts`, `tests/portable-api-range.test.ts`): a table of every Playwright method the generated code calls with the release that introduced it, a table of later options of those calls (`test({ tag })` 1.42, `step({ box })` 1.39, `fetch({ maxRedirects })` 1.26, `filter({ visible })` 1.51, ...), and a list of names that are not Playwright (JavaScript and Node.js built-ins, axe's builder, the helpers' own functions). The test renders scripts for every web step and every assert check, every API response check, a data-driven test and a desktop test, reads them, every helper source the generators paste into scripts and the download's `playwright.config.ts` with the TypeScript parser (so strings and comments never count), and fails when a call is in none of the lists (someone has to classify it, with its version) or needs a newer Playwright than `OLDEST_PLAYWRIGHT`. A name that is both a Playwright and a JavaScript method (`fill`, `filter`, `all`, `get`, ...) counts as Playwright's: the check errs on the strict side. When a generator needs a newer API, either do without it or raise `OLDEST_PLAYWRIGHT` (and the CI matrix follows, its lint test reads the constant).

The version numbers in the table come from Playwright's release notes as the builder knew them; they were not looked up again here (no internet). The CI job below is the real proof.

## On real machines (CI)

`.github/workflows/runner-matrix.yml`, job **portable-exports** (45 minutes at most, `fail-fast: false`), six legs:

| Machine | Playwright | Node.js that runs the download |
|---|---|---|
| `ubuntu-22.04` | 1.42.1 (oldest) | 20 |
| `ubuntu-24.04` | pinned (newest tested) | 24 |
| `windows-latest` | 1.42.1 | 20 |
| `windows-latest` | pinned | 24 |
| `macos-latest` | 1.42.1 | 20 |
| `macos-latest` | pinned | 24 |

Playwright 1.42 predates Ubuntu 24.04 (the browser's system libraries changed names there), so the oldest version runs on 22.04.

Each leg: Node.js 24 and `npm ci` for the platform, then `node scripts/portable-check.mjs --export-only --dir "$RUNNER_TEMP/portable export" --port 6956` (starts the sample app and the platform on a new data folder with a new access key, imports five tests from steps without AI: search, add to cart, an accessibility check with axe plus a page health check, two API tests; saves a code test with a shared helper; downloads the project and unpacks it with the computer's own unzip tool into a folder with a space in its name, **outside the checkout** so nothing of the checkout's `node_modules` can help it). Then the leg's Node.js, and `node scripts/portable-check.mjs --from "$RUNNER_TEMP/portable export" --port 6958 [--playwright 1.42.1] [--install-deps]`: exactly the README's steps (`npm ci`, for the oldest leg `npm install --no-save @playwright/test@1.42.1`, `npx playwright install [--with-deps] chromium`, `npx playwright test`) with `BASE_URL` and `API_BASE_URL` pointing at a sample app on another port than the one the tests were made for (so the settings really steer them). It checks that the download carries exact pins, a lockfile that holds them, `.nvmrc`, the config and the three steps in the README, that the Playwright which ran is the one asked for, and that all 6 tests passed. The report and logs are uploaded as **portable-exports-&lt;leg&gt;**, also after a failure. The pull-request trigger also covers `src/engine/generators/**`, `src/engine/portable/**`, `src/platform/portable-export.ts` and the script.

### Run it on your computer

```
node scripts/portable-check.mjs                         # npm ci and the browser download from the internet
node scripts/portable-check.mjs --playwright 1.42.1     # the oldest supported version
node scripts/portable-check.mjs --link-node-modules     # no internet: links this checkout's node_modules instead of npm ci
```

On a shared machine run it under the lock: `node scripts/with-lock.mjs browser -- node scripts/portable-check.mjs ...`. Exit code 0 passed, 1 failed, 2 wrong arguments; `report.md`, `report.json` and the logs (the access key removed) go to `--out` (default `.scratch/portable-check/<time>`). Like `smoke-runner.mjs` (whose helpers it reuses) it stops only the programs it started, by their handles, removes only the `node_modules` link (never what it points to) and deletes its temporary folder. Ports: `--port` and the next one (default 6956 and 6957).

## Tests

- `tests/portable-api-range.test.ts` (fast tier, 6): the corpus covers every step and check; every call is classified; nothing is newer than 1.42.1; the `{ tag }` option is what sets the oldest version; a script with newer APIs or unknown calls fails the check; strings and comments are ignored.
- `tests/portable-export.test.ts` (in-process platform, 14): Node.js-style resolution; the cut keeps exactly what is needed, copied unchanged, with npm's dev/optional marks; refusals; the Node.js floor; the cut from this repository's real lockfile for Playwright, axe and Taqwright, entry by entry equal to the source and to what is installed in `node_modules`, every dependency resolving inside the cut; package.json, lockfile, `.nvmrc`, config, README for browser, phone and desktop tests and without a lockfile; both download routes (contents, file name, helper of a code test, 404, access key); the script's arguments, test environment (no platform setting or test secret leaks into it) and report reader.
- `tests/portable-export-run.test.ts` (platform and browser, 1): `scripts/portable-check.mjs --link-node-modules` end to end on this computer: export, unpack with `tar.exe`, run the download's own config with the installed Playwright (1.63.0): 6 of 6 passed; the access key in no report or log; the checkout's `node_modules` intact.
- `tests/portable-ui.test.ts` (UI, 4): the Code tab's **Download ready to run** for a test made from steps and for a code test (keyboard), 44 px target, 390 px wide without sideways scrolling, axe clean in light and dark, the Export dialog's wording.
- `tests/runner-matrix-workflow.test.ts` (RM's lint test, extended): the six legs and their Node.js versions, the oldest leg uses `OLDEST_PLAYWRIGHT`, the two setup-node steps, the export outside the checkout, the run command, the upload, the trigger paths, the ports.

## What is not covered (honest limits)

- **Not run on GitHub yet.** The job was checked by the lint test, not on GitHub's machines. **Playwright 1.42.1 was never run here** (no internet): the oldest leg is the first real proof, and macOS 15 with Playwright 1.42's browser builds in particular may need a fix (an older macOS image or a newer oldest version). Linux, Windows and macOS were only run here as Windows 11 x64 with the pinned version.
- **`npm ci` against the cut lockfile was not run here** (it downloads from the npm registry). The lockfile is checked entry by entry against the platform's own and against `node_modules`; the CI job runs the real `npm ci`.
- **Phone tests**: the download places them, pins Taqwright and writes a config, but no phone test was run from a download (no emulator, device or Appium here). **Windows desktop tests** were not run from a download either.
- **Screenshot baselines** stay on the platform: a "looks the same" check run from a download has no approved screenshot yet; Playwright saves one on the first run and reports the test as missing its snapshot once. **Email steps** (codes and links from the test mailbox) and **AI judgement** ("looks right") need the platform: from a download, email steps fail with a plain message and AI judgement only saves the screenshot.
- **Git**: there is no "push to Git" in the platform. The download is laid out to be committed as it is (with `.gitignore`); putting it in a repository is the tester's step.
- Data-driven tests, cleanup of created records, load and latency checks run from a download as they do on the platform, but only the five sample tests and the code test above were run here.
- The version table's "introduced in" values were written from knowledge of Playwright's release notes and were not re-checked online; a wrong value would let a newer API through until the oldest CI leg fails.
