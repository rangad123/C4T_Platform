# Framework adapters and the script executor

Stage 1 of "run tests anywhere". It changes **nothing a user can see**: scripts are byte-identical, results are the same, every stored id is unchanged. What it adds is structure: one contract that describes a testing framework, and one seam through which every script is run, so that

1. a new framework is an addition (one adapter file and one registration line), not a change to the validator, the schedulers, the routes or the UI, and
2. a later stage can change **where** scripts run (a runner agent on another computer) without touching any caller.

## What it does for a user

Nothing yet, apart from `GET /api/config`, which now also lists the available frameworks and what each needs from the machine that runs its tests:

```json
"adapters": [
  { "id": "playwright", "label": "Playwright (TypeScript)", "kinds": ["web"], "executable": true, "runtime": "playwright",
    "needs": { "node": true, "browsers": ["chromium"] },
    "traits": { "visionJudgement": true, "cleanupLedger": true, "browserRepair": true } },
  { "id": "playwright-api", ... "kinds": ["api"], "needs": { "node": true } },
  { "id": "taqwright", ... "kinds": ["mobile"], "runtime": "taqwright", "needs": { "node": true, "android": true } }
]
```

The older `frameworks` list (`framework`, `kind`, `executable`) is still returned unchanged.

## The contract (`src/engine/frameworks/types.ts`)

```ts
interface FrameworkAdapter {
    readonly id: string;                      // stored in databases and backups; never rename a shipped id
    readonly label: string;                   // "Playwright (TypeScript)": plain wording for people
    readonly kinds: readonly TestKind[];      // test kinds it renders and runs: "web" | "api" | "mobile"
    readonly alsoRenders?: readonly TestKind[]; // kinds it can render but does not run natively
    readonly executable: boolean;             // false: scripts are rendered and stored, never run by the platform
    readonly runtime: string;                 // adapters with the same runtime run together in ONE batch
    readonly needs: RunnerNeeds;              // what the machine that runs the scripts must have
    readonly traits: AdapterTraits;           // what the validator may do around a run (see below)
    render(spec: TestSpec, ctx: RenderContext): GeneratedScript;        // pure, wraps the generator
    execute(batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]>;
    describe(): AdapterDescription;           // JSON-safe summary for /api/config and the UI
}

interface RunnerNeeds { node: boolean; browsers?: ("chromium"|"firefox"|"webkit")[]; android?: boolean; ios?: boolean; windows?: boolean }
interface AdapterTraits { visionJudgement: boolean; cleanupLedger: boolean; browserRepair: boolean }

interface ExecutionBatch   { scratchDir: string; scripts: ScriptInput[] }          // ScriptInput = { testId, filename, content, baselines? }
interface ExecutionEnv     { run: RunEnv; mobile?: MobileRunEnv }                   // secrets live here; never logged or stored
interface ExecutionOptions { workers: number; timeoutMs?: number; signal?: AbortSignal; projects?: RunnerProject[] }

interface ScriptExecutor {
    readonly name: string;
    execute(adapterId: string, batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]>;
}
```

`ScriptRun` (the neutral result: status, steps, error, responses, metrics, notes, artifacts, ...) is unchanged; it is what every consumer already reads.

**Traits.** They replace the old "is this Playwright?" questions in the validator:

| Trait | Meaning |
|---|---|
| `visionJudgement` | screenshots of "looks right" steps may be judged by the model after the run |
| `cleanupLedger` | the scripts record the data they create so the platform can remove it afterwards; the validator switches that mode on for the batch |
| `browserRepair` | a failing script can be repaired or healed with a browser on the platform side, so the job launches one |

**Runtime.** Playwright web and Playwright API scripts run in one `playwright test` process (shared workers, one report), so both adapters have `runtime: "playwright"` and a mixed batch is sent as one call. Batches of different runtimes run one after another in the order the adapters were registered (Playwright first, then Taqwright), as before. When a batch holds several adapters of one runtime, it is sent to the first registered one among them, so an adapter must be able to execute any script of its runtime.

## The registry (`src/engine/frameworks/registry.ts`)

| Function | Behaviour |
|---|---|
| `registerAdapter(adapter)` | adds it; a second adapter with the same id throws `DuplicateFrameworkError` (ids are stored in databases) |
| `getAdapter(id)` | the adapter, or `UnknownFrameworkError` with a plain message ("The testing framework "x" is not available in this platform (available: ...)") |
| `listAdapters()` | all adapters in registration order |
| `unregisterAdapter(id)` | removes an adapter added with `registerAdapter` (tests, plug-ins); the three built-ins cannot be removed |
| `renderWithAdapter(spec, id, ctx)` | renders through the adapter; the built-ins return exactly what the generator returned |
| `defaultAdapterFor(kind)` | the first registered adapter that lists the kind (so a later plug-in never takes over web, API or mobile on its own) |
| `needsDevice(adapter)` | true when the adapter needs an Android or iOS device |
| `groupByRuntime(items, frameworkOf)` | splits items into batches by runtime, in registration order |
| `AdapterRegistry` | the class behind these; tests create private ones |

Built-ins (`builtin.ts`) are registered when `src/engine/frameworks/index.ts` loads. Import from `frameworks/index.js`, not from a file inside it.

## The executor seam (`executor.ts`)

Callers never import `runScripts` or `runMobileScripts` any more. They ask an executor:

- `LocalExecutor` (the default, `localExecutor`) resolves the adapter and calls its `execute`, passing the batch, the environment and the options through untouched. The Playwright adapters call `runScripts`, the Taqwright adapter calls `runMobileScripts` (or returns "No Android device is set up for this run." for every script when there is no mobile environment, as before).
- `executorFor({ projectId, jobId, mode, adapters })` is the hook that decides where work runs. Today it always returns the local executor. A later stage installs a resolver with `setExecutorResolver(fn)` that returns a remote executor for projects that use a runner agent (returning `undefined` keeps local).
- `runJob` calls `executorFor` once per job and puts the result on the engine context (`ctx.executor`).
- Every place that runs scripts picks `deps.executor ?? ctx.executor ?? localExecutor`: `ValidationDeps.executor` (the validator: first run, baseline re-run, flaky retry and post-repair re-run), `VariantDeps.executor` (cross-browser variants, which are Playwright projects and so address the `playwright` adapter), `EnvironmentRunRequest.executor` (runs against a named environment). Existing call sites and tests pass none and get the local executor.

## What was replaced

Every place that chose behaviour by framework id now asks the registry:

| Where | Before | Now |
|---|---|---|
| `validation/validator.ts` `execute` | `framework !== "taqwright"` split | batches by `adapter.runtime`; cleanup mode, vision judgement by traits |
| `validate-only.ts` | `framework === "taqwright" && !mobile.env`; `t.framework !== "taqwright"` launches a browser | `needsDevice(adapter)`; `traits.browserRepair` |
| `environments/run.ts` | `getGenerator(defaultFramework(kind)).executable`, `runScripts` | `defaultAdapterFor(kind).executable`, the executor |
| `validation/variants.ts` | `renderScript(.., "playwright")`, `runScripts` | `renderWithAdapter`, the executor |
| `platform/server.ts` | validate route, `/api/config`, import, `POST /api/tests/:id/scripts` (zod enum of three ids), `isExecutable` | `getAdapter(...)`, `adapter.needs.android`, ids from the registry |
| `platform/scheduler.ts`, `runbook-runner.ts` | `framework !== "taqwright"` | `!needsDevice(adapter)` |
| `platform/backup.ts` | known ids from `listGenerators()` | from `listAdapters()` |
| `routes/environments.ts`, `integrations.ts`, `healing.ts` | `getGenerator(defaultFramework(..)).executable` | `defaultAdapterFor(..)` |
| `orchestrator.ts`, `authoring/plain.ts` | `renderScript(spec, framework, ..)` | `renderWithAdapter` |

`Framework` (the id type) is now open: `"playwright" | "playwright-api" | "taqwright" | (string & {})`, so an adapter's id can be stored and passed around without editing a union.

**Left alone on purpose.**

- The orchestrator and plain-English authoring still say `"playwright"` for a web check and `"playwright-api"` for an API check when they create tests. That is a data choice ("the default framework for this kind"), not a behaviour switch.
- `defaultFramework(kind)` in `generators/index.ts` still exists (it is exported and used by tests); `defaultAdapterFor` returns the same ids.
- The web UI (`web/src`) is untouched: `frameworkLabel()` keeps its three wordings, and a test checks they equal the adapters' `label`s, so they cannot drift apart. `TestDetail.tsx` still checks `framework === "taqwright"` for its "Create mobile script" button.
- Taqwright-specific error wording in `labels.ts` and the `taqwright-trace` attachment names in `runner.ts` are about that framework's output, not a switch.

## How to add a framework (steps)

1. **Generator.** Write a pure `ScriptGenerator` (spec in, one script out) like `generators/playwright.ts`, or skip this if your adapter renders on its own.
2. **Adapter.** Create `src/engine/frameworks/<name>.ts` exporting a `FrameworkAdapter`:
   - `id`: new, lowercase, final (it is stored). `label`: plain words.
   - `kinds`: the test kinds it renders and runs.
   - `executable`: `true` only if the platform can run it.
   - `runtime`: a new name unless it really shares one process with an existing runtime.
   - `needs`: what the runner machine must have (`node`, `browsers`, `android`, `ios`, `windows`). Today this is information (shown in `/api/config`); a runner agent will use it to decide whether it can take the work.
   - `traits`: set the three flags honestly. If the framework cannot produce screenshots for `looksRight`, or does not write the cleanup ledger, say `false`.
   - `render(spec, ctx)`: pure and deterministic; refuse kinds it cannot render by throwing a plain error.
   - `execute(batch, env, opts)`: write the scripts into a folder under `batch.scratchDir`, run the framework with the secrets in `env` passed only to the child process (never logged), honour `opts.signal` (kill the process and throw `Error("Job cancelled")` if it was aborted before starting), and return **one `ScriptRun` per script in input order**: `status`, the failing step, `error` text, and any `artifacts`, `responses`, `metrics`, `notes`. Artifact paths must be local files that still exist when the call returns (the platform copies them afterwards).
3. **Register.** Add `registerBuiltInAdapter(yourAdapter)` to the list in `frameworks/index.ts` (or call `registerAdapter` from a plug-in at start-up).
4. **Nothing else.** The validator, variants (if you run Playwright projects), environment runs, schedules, `/api/config`, backups and the import route find it through the registry. If the framework needs a device, `needsDevice(adapter)` is what keeps schedules and runbooks from starting its tests where no device exists.
5. **Test.** `tests/frameworks-unit.test.ts` registers a dummy `noop` adapter and drives it through `validateBatch` with no other change; copy that.

## Limits

- Only the three built-in frameworks exist. No new framework ships with this stage.
- `needs` is descriptive today. Nothing checks it before running, and `executorFor` always answers "here".
- `GeneratorAdapter.executable` is read once from the generator at start-up.
- An adapter id that is stored but no longer registered (for example a plug-in that was removed) gives `UnknownFrameworkError` when such a test is validated or restored; backups of such tests are refused on restore with the existing "unknown format" message.
- Cross-browser variants address the `playwright` adapter by id because the variants are Playwright projects.

## What stage 2 builds on this

- A **remote executor** implements `ScriptExecutor`: it sends `(adapterId, batch, env, opts)` to a runner agent, waits for the `ScriptRun[]`, and downloads the artifacts the runs name into the scratch folder so `RepoSink` and the vision judge keep reading local paths.
- A **resolver** passed to `setExecutorResolver` picks the executor per project or job from the platform's agent registry, using `adapter.needs` to find an agent that can take the work (a Windows desktop, a Mac with a simulator, a machine with an emulator).
- The agent itself can run `getAdapter(id).execute(...)` locally, because `execute` is exactly the local executor's job, so the same code runs on both sides.
- New adapters for those machines (iOS, Windows desktop) are additions under `src/engine/frameworks/`, with `needs.ios` / `needs.windows` set.
