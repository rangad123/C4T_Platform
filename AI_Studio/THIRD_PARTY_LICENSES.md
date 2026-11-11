# Third-party licenses and attribution

This project reuses code from, or is informed by, five open-source repositories. Each was cloned,
its LICENSE inspected **before** any code was copied, and its reuse recorded here. The clones live
in `references/` (git-ignored) and are not part of the distributed platform.

| Repository | URL | License | Copyright holder | Status |
|---|---|---|---|---|
| autospec | https://github.com/zachblume/autospec | MIT (LICENSE file) | Copyright (c) 2024 Zach Blume | **Code adapted** |
| QAAgency | https://github.com/ninacoelhodr/QAAgency | MIT (declared in `package.json` and README; no LICENSE file in the repo) | Not stated | **Ideas only — no code** (the code once taken from it was replaced) |
| ai-testing-agent | https://github.com/dannicolau7/ai-testing-agent | MIT (LICENSE file) | Copyright (c) 2026 dannicolau7 | **Logic ported** (Python → TypeScript) |
| Taqwright | https://github.com/taqelah/taqwright | Apache-2.0 (LICENSE file) | (see its LICENSE) | **Used as an npm dependency** (`@taqwright/taqwright`) to execute mobile tests; API-compatible script generation — no source copied |
| autonomous-qa-agent | https://github.com/iklymchuk/autonomous-qa-agent | **None found** (no LICENSE file; none declared in `pyproject.toml` or README) | — | **Reference only — no code copied** |

## Components reused, and where

### autospec — MIT
| Platform file | What was reused | How it was changed |
|---|---|---|
| `src/engine/llm/provider.ts` | Provider factory pattern over the Vercel AI SDK (`src/ai.ts`) | Env-driven provider/model, OpenAI-compatible endpoint, retry, usage tracking |
| `src/engine/discovery/browser.ts` | Isolated browser context per task, `ariaSnapshot()` page representation, same-host navigation guard (`src/browser.ts`) | Guard now aborts cross-host document navigations at the network layer |
| `src/engine/web/author.ts` | The tool-calling executor loop: semantic browser tools returning a fresh accessibility snapshot after each step, `stopWhen` + `hasToolCall` (`src/executor.ts`) | Actions are recorded as structured canonical steps; assertion tools are mandatory; supports resume-from-prefix for repair |
| `src/engine/generators/playwright.ts` | Action → Playwright mapping (`src/reporter.ts` `actionToPlaywright`) | Driven by the canonical spec, adds real assertions, `test.step` wrapping, secret-safe data handling |
| `src/engine/planning/planner.ts` | Planning guidance ("most important journeys, fewest steps, from intended functionality") (`src/planner.ts`) | Structured scenarios instead of one-line specs |
| `src/engine/vision/*`, `imageObject` in `src/engine/llm/provider.ts` | **Idea and pattern**: screenshot after interaction (`src/browser.ts` `saveScreenshot`, used by `src/planner.ts`) and structured model output via `generateText` + `Output.object` (`src/planner.ts`). autospec saves screenshots but only sends accessibility snapshots to the model; sending the image to a vision model is new here | A vision model judges the screenshot; zod-checked verdict with confidence rules, opt-in, shrunk and capped images, honest "could not run" behaviour, replayable `looksRight` check |

### QAAgency — ideas only
No code from QAAgency is in this project. Earlier versions carried code copied or ported from it in four files
(`src/engine/discovery/network.ts`, `snapshot.ts`, `docs.ts`, and the sign-in checks in `auth.ts`); since its
repository has no LICENSE file and names no copyright holder, those parts were written again from their tests,
callers and types, without its source, and nothing of it is redistributed.

Ideas it was read for, which carry no licence obligation, are acknowledged here: a per-site knowledge base that later
runs start from (`src/engine/memory/*`, `src/platform/memory-store.ts`), framing the site analysis and the test plan
around a QA engineer's view of the whole site (`src/engine/understanding/analyzer.ts`, `src/engine/planning/planner.ts`),
an application model of pages, elements, APIs and flows (`src/engine/understanding/app-model.ts`), and reading the
test-case and API pages some practice sites publish (`src/engine/discovery/docs.ts`).

### ai-testing-agent — MIT
| Platform file | What was ported | How it was changed |
|---|---|---|
| `src/engine/api/openapi.ts` | `spec_ingestion.py`: `$ref` resolution, parameter merging, OpenAPI 3 `requestBody` / Swagger 2 body, response schemas, security, base URL | Python → TypeScript; adds `allOf`/`oneOf` handling and well-known spec URL probing |
| `src/engine/api/test-specs.ts` | `request_body_handler.py` edge-case matrix (missing fields, wrong types, empty/long strings, SQL-injection and XSS payloads, unknown ids, auth) and failure-triage prompt shape (`failure_analyzer.py`) | Expressed as canonical specs (not pytest source); deterministic; safe-by-default for state-changing methods |

| `src/engine/api/workflows.ts` | **Ported** `chain_detector.py` + `chain_test_generator.py`: resource naming, consumer detection, CRUD chain ordering, login → secured-endpoint chains, id/token field detection from response schemas | Canonical specs with `extract` + `{{var}}` instead of pytest; added safe list → detail chains, wrapped responses, nested resources; mutating chains gated by `allowMutatingApiTests` |
| `src/engine/requirements/parse.ts` | Requirement categories from `parse_requirements` (features, user stories, acceptance criteria, edge cases) and its `example_requirements.txt` layout as a supported format | New deterministic pre-pass, id preservation, zod-validated output, bounded LLM refinement, no-LLM fallback |

| `src/engine/compliance/controls.ts` | **Ported** the control library from `compliance.py` (21 controls: NIST 800-53, HIPAA, ISO 27001, their keywords and method filters) | Generated from the upstream definitions into TypeScript data |
| `src/engine/compliance/map.ts` | The mapping rule (method filter + path/tag keywords) of `ControlMapper` | Whole-word matching instead of substring, path parameters ignored, web tests supported, coverage statuses derived from validation results |
| `src/engine/environments/*`, `src/platform/environments-store.ts`, `src/platform/environment-run.ts` | **Ported** the idea of `env_manager.py`: named environments (dev / staging / production) with variables and a read-only "production" mode that blocks destructive tests | Stored per project in SQLite (not YAML files); secrets encrypted and write-only; production needs an explicit confirmation per run; results kept per environment next to (never instead of) a test's main result |
| `src/engine/testdata/dataset.ts`, `src/platform/environments-store.ts` (data sets) | **Ported** the idea of `data_manager.py`: test data loaded from files (YAML / JSON) with validation and warnings | CSV, JSON and YAML (Excel not supported); validated tables with limits; rows rendered as one test each with the data embedded in the script |

The tool's pytest generation, mock-AI fallback and CLI are **not** used.

### Taqwright — Apache-2.0
No source is copied. The package is a runtime dependency: `src/engine/validation/mobile-runner.ts` runs its CLI
(`taqwright test`) and `taqwright install --with-avd` provisions the Android toolchain (which downloads the Android SDK
under Google's SDK license and a JDK under their own terms, onto the user's machine at their request).
`src/engine/generators/taqwright.ts` emits code against Taqwright's public
API (`@taqwright/taqwright`: `test`, `expect`, `mobile.getByRole/getByLabel/getByText/...`,
`openDeepLink`), which was verified against the cloned source. Generated mobile scripts depend on
that package; its Apache-2.0 terms apply to whoever installs it. If source from Taqwright is ever
copied into this repo, retain its LICENSE text and note changed files per Apache-2.0 §4.

### autonomous-qa-agent — no license
Without a license, all rights are reserved by default, so **no code was copied**. It was read as
architectural reference only (BFS crawler with DOM extraction, GPT flow inference, pytest-Playwright
generation, axe-core accessibility audit, severity scoring). Platform equivalents were written
independently or taken from the permissively licensed repositories above. If the author adds an
open-source license, nothing here depends on it: the platform's accessibility audit
(`src/engine/a11y/`, on `@axe-core/playwright`), severity scoring (`src/engine/validation/severity.ts`)
and visual regression (`src/engine/visual/`, on Playwright's `toHaveScreenshot`) were written
independently.

## Runtime dependencies
Playwright (Apache-2.0), Vercel AI SDK `ai` and `@ai-sdk/*` (Apache-2.0), Fastify (MIT), React (MIT),
Vite (MIT), zod (MIT), yaml (ISC), fflate (MIT), `@axe-core/playwright` + `axe-core` (MPL-2.0, used
unmodified as a library — MPL obligations apply only to modified MPL files), mammoth (BSD-2-Clause),
unpdf (MIT), nodemailer (MIT-0, sends email alerts over SMTP; `@types/nodemailer`, MIT, dev only), `@modelcontextprotocol/sdk` (MIT, the MCP server in `src/mcp/`), lucide-react (ISC, UI icons), CodeMirror 6 (`@codemirror/state`, `view`, `commands`, `language`, `lang-javascript`, `search`, `autocomplete`, `lint`, and `@lezer/highlight`, all MIT; the script editor in `web/src/features/code/` and the code colours in `web/src/components/code-spans.ts`, both loaded on demand), Instrument Sans (SIL OFL-1.1, the UI typeface) and JetBrains Mono (SIL OFL-1.1, labels, badges and code), both loaded from Google Fonts by `web/index.html` and not bundled. Their licenses are in `node_modules/*/LICENSE`.

The **runner kit** (`npm run build:runner`, the download in Setup, Runners) hands out a bundle of this project's agent and engine code that includes copies of zod (MIT) and yaml (ISC); their licence texts travel in the kit as `LICENSES.txt`. The kit's `package.json` makes the receiving computer install Playwright, `@axe-core/playwright` (MPL-2.0, as a library), TypeScript (Apache-2.0) and, optionally, Taqwright from the npm registry itself; nothing else of theirs is copied into the zip. esbuild (MIT) is used only to build the bundle and is a transitive development dependency, not a direct one.

The **complete runner download** (`npm run build:runner -- --complete`, round 17) redistributes more: the official Node.js binary (`node` or `node.exe`, MIT, with Node.js's own `LICENSE` file, which lists the licences of the libraries built into it, shipped next to it in `node/LICENSE`) and the kit's packages with everything they depend on, copied unmodified from `node_modules` with their own `LICENSE` files in their folders: Playwright and playwright-core (Apache-2.0), TypeScript (Apache-2.0), `@axe-core/playwright` and axe-core (MPL-2.0, unmodified), and Taqwright (Apache-2.0) with its 160 or so dependencies (checked when this was written: MIT, ISC, Apache-2.0, BSD-2/3-Clause, 0BSD, BlueOak-1.0.0, node-forge under BSD-3-Clause OR GPL-2.0 used under BSD-3-Clause, and one CC-BY-4.0 package, `@promptbook/utils`, whose attribution travels in its folder). No new dependency of the platform itself was added.

## The MIT License (applies to autospec and ai-testing-agent)

```
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

Copyright notices to retain:
- Copyright (c) 2024 Zach Blume (autospec)
- Copyright (c) 2026 dannicolau7 (ai-testing-agent)

## External security scanners (optional, not redistributed)

`src/security/scanners/` can run four external security tools as separate processes or services. **No code from any of them is copied,
vendored, linked or bundled here**, and none of them is installed by this project or distributed with it: the platform only starts a tool
an administrator has installed and named in `SECURITY_SCANNERS` (see [docs/features/security-scanners.md](docs/features/security-scanners.md)).
Each keeps its own licence and its own copyright holders, and is governed by its own terms as installed by whoever installed it:

| Tool | Licence | How it is used |
|---|---|---|
| [OWASP ZAP](https://www.zaproxy.org/) | Apache-2.0 | Its running daemon is talked to over its documented HTTP API; nothing is redistributed |
| [ProjectDiscovery Nuclei](https://github.com/projectdiscovery/nuclei) | MIT | The binary is started as a process against a reviewed template directory; templates are the user's own |
| [Schemathesis](https://github.com/schemathesis/schemathesis) | MIT | The command is started as a process against an API document the client uploaded |
| [Promptfoo](https://www.promptfoo.dev/) | MIT (some optional packages Apache-2.0) | The command is started as a process against a configured AI interface |

What was reused is their **public interfaces** - command-line flags, output formats and API endpoints - which is interoperability, not reuse of
code. `docs/features/security-scanners.md` records which of them were actually run against the fixture application while this feature was
built (Nuclei, Schemathesis and Promptfoo were; ZAP was not, and its adapter is untested against a live daemon).

Frameworks that were considered and **not** used - Strix, PyRIT and garak - are not installed, required, called, or integrated in any
form, so no licence obligation arises from them. The reason for each is recorded in
[docs/features/security-scanners.md](docs/features/security-scanners.md#other-ai-frameworks-considered-and-not-used).
