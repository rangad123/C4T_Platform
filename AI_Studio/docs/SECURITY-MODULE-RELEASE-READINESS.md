# Security Assessment module: release readiness

An audit of the Freit Security Assessment engine against the work actually observed on this machine, not against what the code claims.
Every statement below names the evidence it rests on. Where something is not proven, it says so.

Audit date: 2026-10-23. Environment: Windows 11 Pro 10.0.26200, Node v24.19.0, npm 11.17.0, vitest 2.x, TypeScript (strict),
Fastify 5, zod 4, Playwright with Chromium installed.

---

## Verdict

**Ready for a controlled client pilot. Not ready for broader production use.**

The reason is not an open defect in the module: the passive assessment path, the scope guard and the ZAP integration were all exercised
end to end against a real target and a real daemon, and the defects that audit turned up were real and are fixed. The reason is coverage:
two of the four scanners have never been proven to run here, and the fourth cannot be reached through the product at all. A pilot whose
scope is passive assessment plus ZAP is defensible. A general release that advertises four scanners is not.

---

## P1 - OWASP ZAP: root cause found, fixed, and verified

### What was actually wrong

Nothing was wrong with the adapter. The daemon was being started with the wrong flags, in a way that silently corrupted ZAP's own
configuration file.

The previous start line used `-config api.addrs.addr.name=127.0.0.1`. ZAP's `-config` prefix parser collapses the dotted path, so
`api.addrs.addr.regex` was written into `%USERPROFILE%\ZAP\config.xml` as a single element holding the **string** `127.0.0.1` where a
**boolean** belongs. From then on, every start logged:

```
ERROR AbstractParam - 'regex' doesn't map to a Boolean object
    at org.zaproxy.zap.extension.api.OptionsParamApi.loadPermittedAddresses(OptionsParamApi.java:345)
```

The API's permitted-address configuration therefore never loaded. Requests were refused as "not permitted", and on later starts the API
did not bind port 8090 at all - which is why the symptom looked like "the daemon is up but hangs up on every `/JSON` request", and why
no combination of documented flags appeared to help.

### The fix

Use ZAP's documented `-host` / `-port` and never `-config api.addrs.*`:

```
zap.bat -daemon -config api.enabled=true -host 127.0.0.1 -port 8090
```

The poisoned element was repaired once (`<regex>false</regex>`; the original is kept beside the file as
`config.xml.corrupt-backup`). With `-host`/`-port` no repair is needed on any later start.

`.env.example`, `docs/ADMIN_GUIDE.md` and `docs/features/security-scanners.md` all carried the wrong command and have been corrected,
with the failure mode written down so the next operator does not repeat it.

### What is now verified, against the real daemon

`tests/security-zap-daemon-live.test.ts` (new, 7 tests, all passing against ZAP 2.17.0) and
`tests/security-scanner-e2e.test.ts` (5 tests, all passing) cover:

| Behaviour | Result |
| --- | --- |
| Health check and version | `available`, version `2.17.0` |
| Nothing listening on the port | `unavailable`, "ZAP could not be reached", remedy points at starting ZAP - **not** at the API key |
| Wrong API key | Reported as the closed socket it really is, naming **both** causes and saying to check the key **first** |
| Address that answers but is not ZAP | Recognised as such |
| Real passive scan | Real alerts, mapped into Freit's finding schema with evidence, CWE and ZAP's own remediation |
| Alerts outside the addresses given | Filtered out, and counted in the coverage list |
| Cancellation mid-scan | Genuinely in flight (fixture route holding the request open); run fails, daemon left usable and unchanged |
| Run abandoned part-way | Daemon survives and is reusable |

### Two real defects the live daemon exposed

**1. ZAP's daemon-global alert table leaked findings across runs.** `core/view/alerts` returns everything the daemon has ever raised.
A run given a single address was handed alerts for three, while its own coverage line claimed one address was in scope. Fixed with
`alertIsInScope()` plus filtering in `start()`; the coverage list now reports how many alerts were left out and why. Regression test added.

**2. A wrong API key cannot be told from a closed API.** ZAP 2.17 closes the socket identically in both cases. The adapter no longer
guesses one cause; it names both and tells the operator to check the key first.

### One characteristic worth knowing

`ZapAdapter.start()` is **eager**: it runs the whole scan before returning a handle. A cancellation therefore surfaces as `start()`
rejecting, not `results()` rejecting, and a caller that awaits `start()` before arming its signal will cancel nothing. Documented in the
adapter header and demonstrated in the live test.

---

## P2 - Regression testing

### Commands and results

| Command | Result |
| --- | --- |
| `npx tsc --noEmit` | **Clean for the security module.** The whole tree now reports 2 errors, both in `src/engine/mobile/explore/spec-builder.ts`, from work in the mobile engine that was being edited in this repository **at the same time** as this audit (see the note below). No error is in `src/security`. |
| `npx vitest run tests/security-*.test.ts tests/security-zap-daemon-live.test.ts` (with the live fixture and the live ZAP daemon) | **391 passed, 0 failed, 0 skipped**, 31 files, 556 s |
| `npx vitest run tests/security-scanner-integration.test.ts` (with `SECURITY_TEST_FIXTURE_URL`) | **4 passed**, 184 s |
| `npx vitest run tests/security-scanner-e2e.test.ts` (live ZAP) | **5 passed**, 45 s |
| `npx vitest run tests/security-zap-daemon-live.test.ts` (live ZAP) | **7 passed**, 6 s |
| `npx vitest run tests/security-findings-unit.test.ts` | **19 passed**, 10 s |
| `npx vitest run tests/guide-content.test.ts` | **17 passed**, 10 s |
| `npm test` (whole suite) | **5458 passed, 17 failed, 63 skipped** (5538 tests; 306 files), 9207 s - see "The whole suite" below |

### Tests that could not run, and why

`tests/security-scanner-integration.test.ts` skips per tool rather than failing when the binary is absent:

- **nuclei - not installed on this machine.** No `nuclei` executable on PATH, and **no real nuclei output is captured anywhere in the
  repository**. Its adapter is covered by unit tests only, including hand-written JSONL for the parser.
- **promptfoo - not installed on this machine.** A real `promptfoo-result.json` (50 KB) *is* captured under `tests/fixtures/security/`
  and the parser is tested against it, but no live run is reproducible here.

Both say so in the test output rather than passing silently.

### The whole suite

`npm test` ran for **2 h 33 m** (9207 s) and reported **17 failed / 5458 passed / 63 skipped** across 306 files.

**That run started before the changes in this document were made, so it is not authoritative for the security module.** Every failure was
therefore re-examined rather than assumed. Running the failing files again, one at a time and unloaded, gives this:

| Failure | Cause | Re-run |
| --- | --- | --- |
| `tests/vision.test.ts` - whole file, 44 skipped, `EADDRINUSE 127.0.0.1:5471` | **This audit's own fault**: the security fixture was running on port 5471, which `tests/vision.test.ts` uses for its scripted model endpoint. | **44 passed** once the fixture moved to port 5310. The fixture now documents that 5470/5471 belong to the vision test. |
| `tests/security-findings-unit.test.ts` - the 2 tests added by this audit | The suite had already loaded the **old** `findings/ingest.ts` and `findings/normalize.ts` before the fix was written. The failure itself shows the old behaviour (`source: "built-in"`). | **391 passed** in the clean security run above. |
| `tests/ios.test.ts` (5), `tests/custom-agent.test.ts` (5), `tests/stream.test.ts` (1), `tests/ops.test.ts` (1), `tests/tooltips-ui.test.ts` (1) | Load-induced flakes: this audit was running heavy browser suites concurrently with the whole suite. | **All pass** when re-run unloaded (`ios`, `custom-agent`, `stream`, `ops`, `runner-check`: 71 passed, 1 failed; `tooltips-ui`: 45 passed). |
| `tests/runner-check.test.ts` - `check-computer.sh under Git Bash does the same` | **Reproducible.** Git Bash in this environment has no `dirname` and no `sh` on its PATH (`dirname: command not found`, `exec: sh: not found`). Environmental, not a code defect. | Fails again in isolation. |
| `tests/installer-mac-unit.test.ts` - `a pid file that is stale, or points at some other program, is ignored and that program is never killed` | **Reproducible.** The test writes a pid taken from Git Bash's own numbering and then checks it with `kill -0`; on Windows the two pid spaces do not agree. It is a macOS-installer test running under Git Bash on Windows. | Fails again in isolation. |

The two reproducible failures are in the desktop runner kit and share no code with the security module
(`tests/installer-mac-unit.test.ts` imports only Node built-ins and `scripts/build-installer-mac.mjs`). They are reported, not fixed:
fixing them without evidence of what they should do would be guesswork, and the instruction was not to change unrelated behaviour
without such evidence.

### One thing about this repository during the audit

**This repository was being edited by something else while this audit ran.** Files under `src/engine/mobile/`, `src/agent/`,
`src/platform/` and `src/engine/` were rewritten between 20:43 and 21:01, and `src/engine/mobile/explore/types.ts` gained four new
`PhoneFamily` members (`tabs`, `search`, `settings`, `journeys`) without `src/engine/mobile/explore/spec-builder.ts` being updated to
match. That is the whole of the 2 remaining `tsc` errors.

This has two consequences worth stating plainly:

- The 2 type errors are **not** from the security module and were **not** introduced here. The security module type-checks clean.
- The whole-suite run is a snapshot of a tree that was moving underneath it, which is part of why 8 of its 17 failures turned out to be
  load or timing artefacts. Re-run the whole suite from a settled tree before treating its headline number as the repository's.

---

## P3 - End-to-end verification

`tests/security-scanner-e2e.test.ts` drives the **real** platform in-process against the deliberately vulnerable
`examples/security-fixture`, with a **real ZAP 2.17.0 daemon**. No port is opened for the platform itself.

Nothing in the test drives the assessment. The embedded assessment loop - the same one production uses - must claim and run it, which
is what makes this evidence rather than a harness demonstration.

| Step | Verified |
| --- | --- |
| 1. Register an application | `POST /projects/:id/applications`, 201 |
| 2. Record authorization and scope | `POST /applications/:id/authorizations`, `state: current`; a fresh application is confirmed to have **no** authorization first |
| 3. Create an assessment | `POST /applications/:id/assessments`, 201 |
| 4. Execute the configured scanner | Health `available`; the run is recorded `COMPLETED` with findings |
| 5. Persisted progress and terminal state | Polled through the ordinary API until terminal; no sleep, no direct loop call |
| 6. Retrieve real findings | Stored external findings match the run's own count, each with ZAP's own rule id in its evidence |
| 7. Evidence and remediation | Read back individually; evidence present, remediation kept, `source: external` |
| 8. Security report | Generated and names ZAP |
| 9. Cancel an active job | A genuinely in-flight assessment is cancelled; state becomes `CANCELLED`, `finishedAt` set, the application is immediately free for a new one |
| 10. Functional isolation | A security assessment creates **no** functional validation job; findings carry a tool id or a platform check id and never reference a functional run |

### A second integration gap this test found

`loopDeps()` never attached `deps.scanners`, so **an assessment started through the platform's own API never ran a scanner at all**. The
scanner layer was reachable only from hand-built `RunnerDeps` in tests - which is exactly how a broken integration stays invisible.
Fixed: `loopDeps` now attaches the scanner settings when any scanner is enabled, and the runner resolves the per-application saved
sign-in through `signInFor` rather than a loop-wide value.

---

## P4 - Security and deployment review

| Area | Finding |
| --- | --- |
| Scope enforcement | Every address handed to a scanner comes from the guard's own discovery and is stripped of excluded paths and sensitive workflows. No address under an excluded path is ever passed out (`security-scanner-orchestration-unit.test.ts`). |
| SSRF / address classes | `addressClass` refuses loopback, private, link-local, CGNAT, multicast, unspecified, reserved and broadcast unless `SECURITY_ALLOW_PRIVATE_TARGETS=true`. Covered for IPv4, IPv6 and IPv4-in-IPv6 spellings. |
| Cloud metadata | **Always** refused, never by setting: IPv4 (`169.254.169.254`, `169.254.170.2`, `169.254.169.253`, `100.100.100.200`, `192.0.0.192`), IPv6, and by name (`metadata.google.internal`, `metadata`, `instance-data`, `metadata.azure.internal`, ...). |
| DNS resolution | **Every** answer a name resolves to must be allowed; a name with one bad answer is refused. |
| DNS rebinding | Each lookup is judged on its own - an answer that changes to a private address is refused. |
| DNS pinning | The connection goes to the address that was checked, not to a second lookup. |
| Redirects | Each hop is re-checked; a redirect out of scope, into an excluded path or to a metadata address is never followed. There is a redirect limit. |
| Schemes and methods | Only http/https; credentials in a URL are refused; only GET, HEAD and OPTIONS are sent by the passive guard. |
| Spec-driven SSRF | An uploaded OpenAPI document can name its own `servers`. `rewriteServers()` rewrites `servers` to the scope-checked origin, and `--url <that origin>` is passed for YAML and Swagger 2.0, which have no `servers` key. |
| Tenant isolation | Two projects never see each other's scanners or runs; findings, runs and reports are all project-scoped. |
| Secret redaction | Redaction happens before storage. There is a test asserting no secret reaches any security table. The ZAP API key is sent as a header, never in a URL, never logged, never returned by the API - reported only as set or not set. |
| Worker privileges | Scanner processes run with **no shell** (`spawn` with an argument array), from a scrubbed environment that withholds the platform's own secrets, with bounded output, a hard time limit, and a process-tree kill. The executable is administrator-configured and never taken from a request. |
| Temporary artifacts | API documents are written to an owner-only temp directory that is removed on the way out, never under the data directory. |
| Rate limits | A tool is clamped to the smaller of the platform ceiling and the application's own agreed rate; ZAP gets a matching rate-limit rule before an active scan. |
| Cancellation | Verified live (E2E and the daemon test). ZAP's `ascan/action/stop` is called, the mode is restored, and the context is removed. |
| Audit logging | Assessment start, finish, cancel, authorization record/revoke and the emergency stop are all audited and mirrored into Activity. |

### Gap found and fixed

**Evidence from a folded rule was silently discarded.** `group()` in `findings/ingest.ts` keeps the most serious wording when two drafts
share a fingerprint and throws the other away - including its evidence. This is reachable in practice: ZAP rules **10038**
(Content-Security-Policy missing) and **10021** (X-Content-Type-Options missing) both carry **CWE-693**, so `canonicalRule` keys them both
as `zap:cwe-693` and they fold into one finding at one address. The client was shown one problem, the other stayed open, and nothing in
the record said so. The "Also reported by ..." note could not cover it either, because both drafts share the same tool.

Fixed: the folded draft's evidence is kept and its rule is named in an "Also matched by" note. Two regression tests added.

### Observability gap (not fixed, reported)

There is **no audit/Activity event for an individual scanner run**. A run is recorded in `security_scan_runs` and is readable through
`GET /assessments/:id/scans` and in the report, but an operator cannot see "ZAP ran at 14:03 against this application" in the Activity
feed without opening the assessment. Acceptable for a pilot; worth an event before general release.

---

## P5 - Integration status

| Integration | Status | Evidence |
| --- | --- | --- |
| **OWASP ZAP** | Fully implemented and tested | Real 2.17.0 passive scan through the platform's own API, run by the embedded assessment loop; alerts stored with evidence; cancellation verified in flight; health, wrong-key, unreachable and non-ZAP responses verified (7 live + 5 E2E tests). |
| **Schemathesis** | Fully implemented and tested | Real 4.32.4 run against the fixture (183 s), real NDJSON captured in `tests/fixtures/security/`. |
| **Nuclei** | Implemented but not tested in the current environment | Binary not installed; the live test skips with a stated reason; no real nuclei output is captured in the repository. Unit tests only. |
| **Promptfoo** | Partially implemented | The adapter parses a real captured `promptfoo` 0.124.1 result correctly, but **the product has nowhere to record an AI interface**: no column on the application record, no route, no field in the web app. A real assessment can never be given one, and the adapter always refuses with "No AI interface is configured for this application". |
| **Akto** | Unsupported | Scanning is delivered through Akto's own control plane; findings would live there, not in Freit. |
| **Strix** | Unsupported | Interface only. A large autonomous agent framework; integrating it means taking on its runtime. |
| **PyRIT** | Unsupported | Needs a target adapter per provider, a scorer registry and a conversation setup before it can run. |
| **garak** | Unsupported | A single-purpose scanner aimed at a model endpoint the platform would have to own. |

**Daemon availability is not scanning.** The health view reports reachability separately from the ability to scan, and a scan that could
not run produces **no findings** rather than a clean result. This distinction is the reason the earlier "ZAP works" claim was wrong, and
it is now enforced by tests.

---

## Blockers

None for a passive + ZAP pilot.

## Risks

1. **Two scanners are unproven here.** A pilot that enables Nuclei or Promptfoo is running code this audit could not verify.
2. **Promptfoo is unreachable through the product.** Enabling it produces a permanent "no AI interface configured" skip.
3. **Two reproducible failures outside the security module**, both environmental: the macOS installer's pid handling under Git Bash on
   Windows, and `check-computer.sh` under Git Bash with no `dirname`/`sh` on its PATH. Untouched, because changing them without evidence
   of what they should do would be guesswork.
4. **The whole-suite run is not authoritative for this module** - it predates the fixes. The security set was re-run cleanly instead
   (391 passed, 0 failed).
5. **Eager `start()`** in the adapters means a caller that awaits before arming a cancel cancels nothing. Documented; a future refactor
   should make it lazy.

## Limitations

- Wall-clock scan timeouts are unit-tested with a controlled clock, not against a live daemon: ZAP's API has no "stop after N seconds"
  and the adapter quantises its limit to whole minutes. What is proven live is that a dropped or cancelled run leaves the daemon clean.
- ZAP active profiles (`conservative-active`, `advanced`) are **not** covered by the live tests - only `passive` is exercised end to end
  against the real daemon. The active code path is unit-tested but has not been run against real ZAP here.
- Nuclei and Promptfoo have no live run in this environment.
- No scanner run appears in the audit/Activity feed.

## Recommended next actions

1. Install `nuclei` and `promptfoo`, point the platform at them, and re-run `tests/security-scanner-integration.test.ts` to move both out
   of "not tested in the current environment".
2. Add storage, a route and a field for the AI interface on the application record, or remove Promptfoo from the offered list. Do not
   leave it selectable and permanently unable to run.
3. Add an Activity event for a scanner run.
4. Exercise ZAP's `conservative-active` profile against the fixture with a real daemon before any pilot that uses it.
5. Investigate and fix the two reproducible Git-Bash-on-Windows failures, then re-run the whole suite cleanly from the current tree with
   nothing else running alongside it - three of this audit's own "failures" were load or port contention, not defects.
6. Run the whole suite once from the current tree with no other load, so the headline result is authoritative for the whole repository
   rather than for the security module alone.

## Verdict, restated

**Controlled client pilot**, limited to passive assessment with ZAP (and Schemathesis where an API document applies), with the operator
running and keying the ZAP daemon themselves using the corrected command. **Not** broader production use: two scanners are unproven,
one is unreachable, and the whole-suite result is not authoritative for this module.