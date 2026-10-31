# External security scanners (SCAN)

An optional layer that lets an assessment **run four well-known security tools** and folds what they find into the ordinary findings, with the
ordinary rules about authorization, redaction, deduplication, history and re-test. It lives in `src/security/scanners/` and needs an
administrator to switch it on before anything runs.

## What it is, and what it is not

- **It is** four adapters, each answering the same contract: what state is the tool in, is this target in scope for it, start it, give me
  the findings. Everything above them — which tools may run, at what rate, with what budget, against which addresses, and what happens to
  their output — is the platform's own code and the same code the read-only checks use.
- **It is not** a way to run an arbitrary command. There is no route, field or flag that takes a binary, a template, a path or an argument
  from a caller. Template selection is the reviewed policy's job, not the request's.
- **It is not** a scanner that can make an assessment pass.** A tool that is not installed, not configured, not allowed for the project or
  refused at the profile is **reported as such** and produces no findings. There is no path where a missing tool becomes a clean result.

## The four tools

| Tool | What it contributes | Verified against a real tool here? |
| --- | --- | --- |
| **OWASP ZAP** | Broad rule coverage: missing headers, cookie flags, disclosure, known injection and cross-site scripting patterns. Talks to a running daemon over its API. | **Yes.** A real ZAP 2.17.0 passive scan, run through the platform's own API by an assessment started the ordinary way, against `examples/security-fixture`. |
| **Nuclei** | One reviewed template at a time - one known misconfiguration each - from a directory an administrator chose. | **No.** Covered by unit tests only. The binary is not on this machine, so the real-binary test skips. |
| **Schemathesis** | Reads the uploaded API document, generates test data from it, and reports answers that contradict the document. | **Yes.** A real `schemathesis` 4.32.4 run against `examples/security-fixture` (183s), with real output captured in `tests/fixtures/security/`. |
| **Promptfoo** | Sends a fixed, reviewed set of adversarial cases to a configured AI interface and reports the ones that did not meet their expected outcome. | **The adapter only.** A real `promptfoo` 0.124.1 run against the fixture, driven directly. The product cannot yet supply the interface - see the status table. |

The honest reading of that column, on **this** machine, today: **ZAP and Schemathesis run a whole scan for real.** Nuclei's binary is
not installed here and no real nuclei output is captured in the repository, so it is covered by unit tests only. Promptfoo has a real
captured report, but the product has nowhere to record the AI interface it needs, so it cannot be reached the way a user reaches it.
Nothing below is marked tested on the strength of having been written.

**What was verified for ZAP, and how.** A real ZAP 2.17.0 daemon is started, driven and checked here:

```
zap.bat -daemon -config api.enabled=true -host 127.0.0.1 -port 8090
$env:SECURITY_ZAP_URL="http://127.0.0.1:8090"
$env:SECURITY_ZAP_API_KEY=<that daemon's key>
$env:SECURITY_SCANNERS=zap
node examples/security-fixture/server.mjs 5310
$env:SECURITY_E2E_FIXTURE_URL="http://127.0.0.1:5310"
npx vitest run tests/security-scanner-e2e.test.ts
```

`tests/security-scanner-e2e.test.ts` starts an assessment through `POST /api/v1/security/applications/:id/assessments`, lets the
**embedded assessment loop** - the same one production uses, not a test-driven one - claim and run it, and then checks that ZAP's own
alerts came back as findings. Verified on 2.17.0: a passive scan of the fixture raised real alerts (anti-clickjacking header missing,
Content-Security-Policy missing, server version disclosed, X-Content-Type-Options missing), each stored with the evidence ZAP matched
on, the CWE it assigned and the fix it states. The same test also proves the cancellation path (a real in-flight assessment is cancelled
and its state becomes `CANCELLED`) and that a security assessment creates no functional test job.

**The daemon must be reachable, which is not the same as being able to scan.** The health view reports the two separately: an
unreachable daemon is `unavailable` with a sentence saying so, a daemon that answers but is not ZAP is reported as such, and a scan that
could not run produces **no findings** rather than a clean result.

## Status of every integration considered

Each integration is one of: **fully implemented and tested**, **implemented but not tested in the current environment**, **partially
implemented**, **not configured**, or **unsupported**. Nothing here is described as working on the strength of having been written.

| Integration | Status | Why |
| --- | --- | --- |
| **Nuclei** | Implemented but not tested in the current environment | The adapter, the reviewed-template policy and its JSONL parsing are all covered by unit tests, and the real-binary test skips with "nuclei is not installed on this machine". **No real `nuclei` output is captured anywhere in the repository** (unlike Schemathesis and Promptfoo, which have real captured reports under `tests/fixtures/security/`), so the claim that a real run once succeeded cannot be reproduced from here. Install nuclei, point `SECURITY_NUCLEI_PATH` at it and re-run `tests/security-scanner-integration.test.ts` before calling this tested. |
| **Schemathesis** | Fully implemented and tested | A real `schemathesis` 4.32.4 run against the fixture, real NDJSON captured in `tests/fixtures/security/`. |
| **Promptfoo** | Partially implemented | The adapter runs a real `promptfoo` 0.124.1 against the fixture's AI interface and its results parse correctly. **But nothing in the product can supply that interface**: there is no column on the application record, no route and no field in the web app, so a real assessment can never be given one and the adapter always refuses with "No AI interface is configured for this application". The scan is proven by driving the adapter directly, not by the workflow. |
| **OWASP ZAP** | Fully implemented and tested | A real ZAP 2.17.0 passive scan of `examples/security-fixture`, started through the platform's own API and run by the embedded assessment loop; its alerts are stored as findings with their evidence, and cancellation is verified against a real in-flight assessment. Health, wrong-key, unreachable-daemon and non-ZAP-endpoint responses are verified too. |
| **Akto** | Unsupported | Its scanning is delivered through Akto's own control plane, which a client would have to stand up and register, and findings would live there rather than in Freit. Not evaluated beyond that. |
| **Strix** | Unsupported | Interface-only. It is a large autonomous agent framework; integrating it would mean taking on its runtime rather than a bounded tool. See the section on other AI frameworks below. |
| **PyRIT** | Unsupported | Needs a target adapter per provider, a scorer registry and a conversation setup before it can run at all. |
| **garak** | Unsupported | A single-purpose scanner aimed at a model endpoint the platform would have to own, which is the opposite of pointing it at a client's application interface. |

## Two gates, and both must be open

1. **The platform switch.** `SECURITY_SCANNERS` names the tools that may run at all. Default: none. Installing a tool on the machine does
   nothing by itself.
2. **The project's allow-list.** An editor sets `PUT /api/v1/security/projects/:id/scanners`. A project with no allow-list gets no scanners,
   whatever is installed and whatever the platform switched on.

The health view reports the two separately, because they are different problems with different fixes: `off` means an administrator must name
it in the environment file, `not-allowed` means somebody must allow it for this project. One project's allow-list grants nothing over another
project's targets.

## The profiles

| Profile | What it may do | Needs approval | Refused in production |
| --- | --- | --- | --- |
| `passive` | Ordinary requests, plus known-file and configuration requests that aim to change nothing. | No | No |
| `conservative-active` | Crafted requests aimed at the application, bounded by the budget and the rate. | No | No |
| `advanced` | Methods that may change what the application holds (POST, PUT, PATCH, DELETE). | **Yes** | **Yes** |

Every profile also carries a `never` list, shown to the client before a scan starts and printed in the report.

`GET /api/v1/security/projects/:id/scanners?profile=advanced` answers with what that profile would do and whether it is allowed **for the
application named by `?applicationId=`.** Without an application there is no environment to judge against, so the answer reports
`allowedHere: null` rather than guessing at one.

### The approval

An `advanced` scan needs a recorded `ScanApproval`: who approved it (`approvedByUserId`, `approvedByName`), when, which environment, and the
exact statement shown. It is stored on the run row, so a report months later can show who agreed to send requests that might change the
application. Without one, nothing starts, and the assessment says why in the coverage list.

Schemathesis additionally checks its own gate: it will not put a state-changing method in `--include-method` without an approval at the
`advanced` profile.

## What a scanner's findings become

A scanner finding is turned into a `RawResult` in **exactly** the shape the platform's own read-only checks produce
(`src/security/scanners/normalize.ts`), so it goes through the same pipeline: redaction before storage, deduplication by fingerprint,
history, re-test comparison, and the same report. A scanner finding is **never** created as confirmed.

**AI findings are always `confidence: "low"` and can never exceed `medium`**, and their description says in words that this is observed
behaviour for a person to judge, not a confirmed vulnerability. An AI evaluation produces leads, not verdicts.

Severity and category are mapped from each tool's own vocabulary onto the platform's (`registry.ts` holds the mapping), and every finding
keeps the tool's own rule id as evidence so a person can look at the tool's record.

### Duplicate folding, honestly

A tool that reports the same rule on the same address a thousand times produces **one** finding plus a coverage line saying how many
reports were folded. Schemathesis against a fuzzed operation really does return thousands of identical reports; the report says so rather
than silently shrinking the number.

## The coverage list: what did not run

This is the part that matters most for a client reading a report. Every run contributes plain sentences:

- a tool that **ran**: `nuclei: 2 findings (4s).`
- a tool that **did not run**: the reason and what to do about it, in the same words as the health page.
- a tool's **own limits**: what it did not inspect (schemathesis says it did not check authorization between users; nuclei says it only
  checks the reviewed templates that are installed; promptfoo says it only checks the defined cases).

**One tool failing never fails the assessment.** Each outcome is recorded separately, the other tools still run, and the assessment finishes
`PARTIALLY_COMPLETED` with the reason in plain words rather than as an error code.

## What each tool does not cover

Read this before promising a client anything.

- **ZAP**: well covered on the patterns its rules know. Not covered: broken access control between users, business-logic problems, and
  anything needing a person's judgement.
- **nuclei**: only the reviewed templates an administrator installed **and reviewed**. A template that was never reviewed does not run. Any
  template outside the configured directory is ignored, so a template that can execute code or read a key cannot be pulled in by accident.
- **Schemathesis**: only operations the API document describes. An operation missing from the document is invisible to it. It also does not
  check whether user A may read user B's record.
- **Promptfoo**: only the defined cases, as observed behaviour. Not the model's internals, and nothing the defined cases do not ask about.

None of the four covers broken access control between users. That is still a person's job.

## The AI evaluation cases

Eight reviewed, bounded cases in `src/security/scanners/promptfoo/cases.ts`: one benign control (its failure means a connectivity problem,
not a finding), two prompt-injection cases (a direct override attempt, and text the application treats as content being obeyed as
instructions), three sensitive-disclosure cases (the configured instructions, credentials, and the application's own configuration), one
excessive-agency case (a claimed destructive action) and one unsafe-tool-use case (a claimed send-out, which also checks the
answer carries no address).

They are **sent to the client's own AI interface**, configured per application, and are listed by the API before anyone consents:

- `GET /api/v1/security/scanners` and `GET .../projects/:id/scanners` both return them with `id`, `category` and a plain `what`.
- Credential cases match **shapes**, so no real key is needed and none is sent.
- The platform sends **no destructive request**: it only reads whether the application *claims* it did something destructive.

## Other AI frameworks considered, and not used

- **Strix** is **not supported**. It is interface-only here: nothing in this repository runs it. It is a large agent framework that needs
  its own model, its own tool permissions and a sandbox to run in, which does not fit "one reviewed adapter against a running client's
  application at an agreed rate". Adding it would mean a second, much larger trust boundary inside the assessment runner.
- **PyRIT** needs a target adapter per provider, a scorer registry and an Azure/OpenAI conversation setup before it can run at all, and its
  red-team orchestrators send state-changing requests freely. The reviewed cases above cover the same ground for this platform's purpose -
  observed behaviour, reviewed in advance, low confidence - with none of that setup.
- **garak** is a single-purpose LLM vulnerability scanner aimed at one model at a time. The platform is pointed at a client's *application
  interface*, not at a model endpoint it owns, and garak's default provider setup is the opposite of that.

None of the three is installed, required, or called. If one is added later it must arrive as another adapter behind the same contract, not as
a special case in the runner.

## API

| Route | Role | What it does |
| --- | --- | --- |
| `GET /api/v1/security/projects/:id/scanners` | viewer | Health of every known scanner for this project, what each covers, the profiles and the AI cases |
| `PUT /api/v1/security/projects/:id/scanners` | editor | `{ enabled: [...] }`. A tool the platform has not switched on is answered as `refused`, not silently dropped |
| `GET /api/v1/security/projects/:id/scans` | viewer | The project's recent scanner runs |
| `GET /api/v1/security/assessments/:aid/scans` | viewer | One assessment's runs, with what each found and what it did not cover |
| `GET /api/v1/security/scanners` | viewer | Platform settings, with every secret reported only as set or not set |

There is deliberately **no route that runs a scanner.** A scan runs as part of an assessment, so it inherits that assessment's authorization,
rate limit, exclusions and cancellation; a separate "run this tool now" endpoint would bypass all four.

Secrets are never in a response. The ZAP API key is read only by `zap/adapter.ts`; the API reports `apiKeySet: true` or `false`.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `SECURITY_SCANNERS` | none | Comma list of the scanners that may run at all |
| `SECURITY_SCANNER_MAX_MINUTES` | 20 | Time limit of one scanner run (1-600) |
| `SECURITY_SCANNER_REQUEST_BUDGET` | 3000 | Most requests one run may send, across every tool (10-200000) |
| `SECURITY_SCANNER_MAX_RPS` | 5 | Hard ceiling for the rate handed to a tool (1-50); the application's own limit wins when smaller |
| `SECURITY_SCANNER_BIN_DIRS` | none | Extra directories searched for binaries (`;` separated on Windows) |
| `SECURITY_ZAP_URL` | none | Base address of the ZAP daemon. ZAP is a separate service |
| `SECURITY_ZAP_API_KEY` | none | Server-side only; never returned by the API, never sent to the browser |
| `SECURITY_NUCLEI_PATH` | auto | Path to the nuclei binary |
| `SECURITY_NUCLEI_TEMPLATES` | none | The reviewed template directory. Templates are chosen from here only |
| `SECURITY_NUCLEI_CONCURRENCY` | 5 | How many templates at once (1-50) |
| `SECURITY_SCHEMATHESIS_PATH` | auto | Path to the schemathesis command |
| `SECURITY_PROMPTFOO_PATH` | auto | Path to the promptfoo command |

Parsing is lenient, like the rest of the platform's settings: an empty line or a typo keeps the default and never stops the platform.

## Windows notes

Real, learned the hard way running these tools here:

- Schemathesis is a Python program: it needs `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8` or it dies with a `UnicodeEncodeError` on Windows.
- Schemathesis exits **1** when it has findings; 0 and 1 are both results, anything else is a failure.
- **`--generation-deterministic` makes Schemathesis ignore `--max-time`.** Verified on 4.32.4: asked for 144 seconds it ran 180 and was still going. It was then killed at the platform's own hard limit before writing its report, so every run was recorded as "did not finish" instead of carrying the findings it already had. The flag is deliberately **not** passed: a tool that will not stop at its deadline cannot be cancelled either, and this platform promises both a time limit and a stop button. Runs are consequently not bit-for-bit repeatable, which is the right trade. The tool is given 80% of the run's time limit so it has the remaining seconds to write its report out.
- Schemathesis writes a `.schemathesis/` cache directory into its **working directory**, with no environment variable to move it (`DEFAULT_ROOT = Path(".schemathesis")` in `schemathesis/core/storage.py`). The adapter therefore runs it with the run's own temporary directory as its working directory, so a scan never drops a cache folder into whatever directory the platform happened to be started in.
- **On Windows, Schemathesis 4.32.4 finishes its work and then does not exit.** Verified: it completes every phase in under a second, prints its full summary, and the process stays alive until it is killed (confirmed with no `--report` flag, with `--report ndjson` alone, and with `--generation-database none`, so it is not the report writer or the examples store). Its `--max-time` is respected for the *work*; it just never returns. The adapter kills it at its own limit and keeps what was reported.
- **Reaching the time limit is not a tool failure.** Because of the above, every Schemathesis run on Windows ends at the platform's kill. It writes its NDJSON report as it goes, so a stopped run still carries everything it actually checked, and the coverage list says plainly that the run stopped there. An earlier version treated "stopped with nothing found" as a failure, which on a well-formed API is *every* run: a scan that correctly found nothing was reported as "did not finish".
- Promptfoo exits **100** when cases fail; again, that is a result.
- Promptfoo needs `{base}/chat/completions` on the AI interface, and `PROMPTFOO_CONFIG_DIR` plus `DO_NOT_TRACK` set so it does not write
  into a user's home directory.
- **ZAP 2.17 closes its API by default**, and it must be opened with its own documented `-host` / `-port` flags:
  `zap.bat -daemon -config api.enabled=true -host 127.0.0.1 -port 8090`. It also refuses plain HTTP without `api.secure=false`.
- **Never set the API address with `-config api.addrs.addr.name` or `-config api.addrs.addr.regex`.** This was the cause of a long
  "the API hangs up on every `/JSON` request" investigation, and the evidence is in the daemon's own log. ZAP's `-config` prefix parser
  collapses `api.addrs.addr.regex` into a single element, writes the string `127.0.0.1` into the **boolean** `regex` element of
  `%USERPROFILE%\ZAP\config.xml`, and every later start then fails with
  `ERROR AbstractParam - 'regex' doesn't map to a Boolean object` from `OptionsParamApi.loadPermittedAddresses`. The API's
  permitted-address configuration then never loads, so every request is answered "not permitted" - and on some starts the API does not
  bind the port at all. The poisoned element has to be repaired once (`<regex>false</regex>`), after which `-host` / `-port` needs no
  repair on any later start.
- **ZAP answers a wrong API key exactly like a closed API**: the socket is closed with no status and no body, so the platform cannot
  tell "the key is wrong" from "the API is not open" from the response alone. It says both in words and points at the key first, rather
  than guessing one.
- **ZAP keeps one alert table for the whole daemon**, and `core/view/alerts` returns everything it has ever raised, not only what this
  run produced. Asking it for the target's origin still returns alerts for pages this assessment never visited. Verified on 2.17.0: a run
  given a single address was handed alerts for three, while its own coverage line said one address was in scope. An alert is therefore
  only kept when its own address is one this run was actually given (`alertIsInScope`), and the coverage list reports how many were left
  out and why.
- A spec file written with a BOM makes Schemathesis fail to parse it.
- On Windows a `.cmd` shim must be launched with `/c` and **one** argument (the whole quoted command line) and
  `windowsVerbatimArguments: true`; `src/security/scanners/cmd-shim.ts` handles this.
- **On Windows, never resolve a tool by its bare extensionless name.** npm's `node_modules/.bin` directories carry a POSIX shell script
  beside every Windows shim — `promptfoo` (a `sh` script) sits next to `promptfoo.cmd` — and Node cannot `spawn` a file with no extension
  on Windows. Matching the bare name first picked the shell script, and every run failed with a bare `spawn ... ENOENT` that named nothing
  useful. `src/security/scanners/binaries.ts` only considers the forms Windows can actually execute: `.exe`, `.cmd`, `.bat`, `.com`.

## Tests

| File | What it covers |
| --- | --- |
| `tests/security-scanner-core-unit.test.ts` | Settings, profiles, approvals, the finding-to-raw mapping and its low-confidence rule for AI |
| `tests/security-scanner-adapters-unit.test.ts` | Each adapter's availability, scope validation, argument building and output parsing, with real captured output in `tests/fixtures/security/` |
| `tests/security-scanner-orchestration-unit.test.ts` | The two gates, one tool failing, coverage lines, cancellation, and that no address under an excluded path is ever handed out |
| `tests/security-scanner-api.test.ts` | Roles, the two gates through the API, the profiles, the AI cases, and two projects never seeing each other's scanners or runs |
| `tests/security-scanner-e2e.test.ts` | The whole workflow against a **real ZAP daemon** and the platform's own fixture: register, authorize, start an assessment through the ordinary API, let the embedded loop run it, read the real findings back, cancel a genuinely in-flight one, and confirm a security assessment creates no functional job |
| `tests/security-zap-daemon-live.test.ts` | The ZAP adapter against a **real daemon**: health and version, nothing listening, a wrong key, an address that is not ZAP, a real passive scan, a cancellation that lands mid-scan, and a dropped run leaving the daemon clean |

`tests/security-scanner-integration.test.ts` runs the adapters against `examples/security-fixture/` with the real binaries. It is skipped unless `SECURITY_TEST_FIXTURE_URL` points at a running fixture, and each test that cannot find its tool says so and skips rather than failing. It asserts the thing that actually matters about an external tool: that it reported real findings, and that it never requested a single address under an excluded path.

`examples/security-fixture/` is a small deliberately vulnerable application used to run the tools for real, with three reviewed nuclei
templates next to it. Two notes for anyone extending it:

- **Nuclei's `-passive` leaves out most of those templates.** Verified on 3.11.1: only 1 of the 3 survives `conservative-active`'s passive flag, because nuclei decides for itself which templates are passive. The integration test therefore runs nuclei at `conservative-active`, where the reviewed templates actually execute. The platform does not second-guess that judgement at run time — it passes nuclei's own flag and reports what nuclei reports.

## Limits

- Four tools, four adapters. Adding a fifth is a new adapter plus one id; the platform never grows a code path per tool.
- A tool that needs a running service (ZAP) is only as good as that service being up. That is reported, not worked around.
- The AI cases are reviewed and bounded. They are not a substitute for someone who understands the client's model and its data.
- A scanner finding is evidence, not a verdict. Nobody is exempt from reading the evidence before telling a client something is wrong.
