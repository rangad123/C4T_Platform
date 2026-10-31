/**
 * Loads adapter plug-ins at start-up and wraps every call into one so a broken plug-in cannot break the platform.
 *
 * Off by default. Plug-ins are read only from the paths in the ADAPTER_PLUGINS environment variable (never from the API or the UI), and
 * only when ALLOW_ADAPTER_PLUGINS=true and API_KEY is set (config.ts). When the switch is off the files are not even opened: a plug-in's
 * module is not imported, so nothing it would do at import time happens.
 *
 * A plug-in is code that runs inside the platform process with all its power. This is not a sandbox: the wrapper contains mistakes
 * (a thrown error, a hung call, a malformed answer), not bad intent. See docs/features/adapter-plugins.md.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { secretsOfRun } from "../evidence/model.js";
import { assertCredentialsStayHome } from "../spec/credential-origin.js";
import { CHILD_ENV_ALLOW } from "../validation/runner.js";
import type { TestSpec } from "../spec/schema.js";
import { checkAdapterShape, checkPluginPath, displayName, errorText, infrastructureRuns, isInside, maskSecrets, parseManifest, PLUGIN_API_VERSION, PLUGIN_LIMITS, sanitizeRuns, sanitizeScript, splitPluginList, type PluginManifest, type ShapedAdapter } from "./plugin.js";
import "./index.js"; // the built-in adapters are registered when it loads: a plug-in is checked against them
import { adapters as sharedRegistry, isBuiltInAdapterId, type AdapterRegistry } from "./registry.js";
import type { AdapterDescription, AdapterTraits, ExecutionBatch, ExecutionEnv, ExecutionOptions, FrameworkAdapter, GeneratedScript, RenderContext, RunnerNeeds, ScriptRun } from "./types.js";
import type { TestKind } from "../spec/schema.js";

// ── what a plug-in is handed ─────────────────────────────────────────────────

/** Handed to render(): helpers for writing a script safely. */
export interface PluginRenderHost {
    apiVersion: 1;
    /** `value` as a JavaScript string literal (quotes included) that is safe to paste into a script, whatever the text holds. */
    js(value: string): string;
}

export interface RunNodeOptions {
    /** Must be inside the batch's scratch folder (use `makeRunDir`). */
    cwd: string;
    /** Arguments for the Node.js program, for example ["check.mjs"]. */
    args: string[];
    /** Extra variables for the child. It never inherits the platform's own secrets: only the usual allow-list plus these. */
    env?: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
}
export interface RunNodeResult {
    exitCode: number | null;
    /** The first 1 MB. */
    stdout: string;
    stderr: string;
    timedOut: boolean;
    aborted: boolean;
}

/** Handed to execute() as its fourth argument: the platform's own safe way to run a child process. */
export interface PluginExecHost extends PluginRenderHost {
    /** A new empty folder inside the batch's scratch folder. */
    makeRunDir(): Promise<string>;
    /** Run Node.js with the platform's filtered environment, a time limit and the abort signal. */
    runNode(o: RunNodeOptions): Promise<RunNodeResult>;
}

const OUTPUT_CAP = 1_000_000;

// JSON.stringify already escapes quotes, backslashes and control characters; the two line separators are the only ones left that could end a line in older engines.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, "g");
const js = (value: string): string => JSON.stringify(String(value)).replace(LINE_SEPARATORS, (c) => `${String.fromCharCode(92)}u${c.charCodeAt(0).toString(16)}`);
const renderHost: PluginRenderHost = Object.freeze({ apiVersion: PLUGIN_API_VERSION, js });

/**
 * `created` collects the folders this host hands out (by the exact path it made), so the platform removes those and only those when the run is
 * over. The name starts with `run-` like the folders of the built-in runners: the platform's hourly sweep of old scratch folders covers whatever
 * is still needed (a screenshot the sink has not copied yet) and anything a crash left behind.
 */
function execHost(scratchDir: string, created: string[] = []): PluginExecHost {
    return {
        apiVersion: PLUGIN_API_VERSION,
        js,
        async makeRunDir() {
            if (created.length >= 200) throw new Error("makeRunDir: too many folders for one run.");
            const dir = path.join(scratchDir, `run-plugin-${Date.now()}-${randomUUID().slice(0, 8)}`);
            await fs.mkdir(dir, { recursive: true });
            created.push(dir);
            return dir;
        },
        runNode(o) {
            if (!(path.resolve(o.cwd) === path.resolve(scratchDir) || isInside(scratchDir, o.cwd))) return Promise.reject(new Error("runNode: the folder must be inside the run folder (use makeRunDir)."));
            if (!Array.isArray(o.args) || o.args.length > 20 || o.args.some((a) => typeof a !== "string" || a.length > 2000)) return Promise.reject(new Error("runNode: args must be a short list of strings."));
            const extra = Object.entries(o.env ?? {});
            if (extra.length > 100 || extra.some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string" || v.length > 8_000)) return Promise.reject(new Error("runNode: env must be a small object of text values."));
            // The same rule as the Playwright runner: the child gets what it needs to run and what the plug-in adds on purpose, never the
            // platform's own secrets (LLM keys, SECRET_KEY, API_KEY).
            const passthrough = Object.fromEntries(Object.entries(process.env).filter(([k]) => CHILD_ENV_ALLOW.has(k.toUpperCase())));
            const env: NodeJS.ProcessEnv = { ...passthrough, FORCE_COLOR: "0", ...Object.fromEntries(extra) };
            return new Promise<RunNodeResult>((resolve) => {
                const child = spawn(process.execPath, o.args, { cwd: o.cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
                let stdout = "";
                let stderr = "";
                let timedOut = false;
                let aborted = false;
                child.stdout.on("data", (d) => (stdout = (stdout + d).slice(0, OUTPUT_CAP)));
                child.stderr.on("data", (d) => (stderr = (stderr + d).slice(0, OUTPUT_CAP)));
                const timer = setTimeout(() => {
                    timedOut = true;
                    child.kill("SIGKILL");
                }, Math.max(1, o.timeoutMs));
                const onAbort = () => {
                    aborted = true;
                    child.kill("SIGKILL");
                };
                if (o.signal?.aborted) onAbort();
                else o.signal?.addEventListener("abort", onAbort, { once: true });
                const done = (exitCode: number | null, extraErr = "") => {
                    clearTimeout(timer);
                    o.signal?.removeEventListener("abort", onAbort);
                    resolve({ exitCode, stdout, stderr: extraErr ? `${stderr}${extraErr}` : stderr, timedOut, aborted });
                };
                child.on("close", (code) => done(code));
                child.on("error", (e) => done(null, String(e)));
            });
        },
    };
}

/** Removes the folders `makeRunDir` made, except those that contain a file one of `keep`'s results points at. Best effort: a folder that stays is swept later. */
async function removeFolders(dirs: readonly string[], keep: readonly ScriptRun[] = []): Promise<void> {
    const wanted = keep.flatMap((r) => r.artifacts.map((a) => a.path));
    for (const dir of dirs) {
        // Artifact paths in the results are real paths (links followed), so the folder is compared by its real path too.
        const real = await fs.realpath(dir).catch(() => dir);
        if (wanted.some((p) => isInside(real, p) || isInside(dir, p))) continue;
        try {
            await fs.rm(dir, { recursive: true, force: true });
        } catch {
            /* the hourly sweep of old scratch folders gets it */
        }
    }
}

// ── the wrapper around a plug-in's adapter ───────────────────────────────────

class Stopped extends Error {
    constructor(readonly why: "timeout" | "cancel") {
        super(why);
    }
}

/**
 * The adapter the platform registers for a plug-in's. It holds plain copies of the declared data and calls the plug-in only through
 * `render` and `execute`, each guarded: errors are caught, time is bounded, answers are checked.
 */
export class PluginAdapter implements FrameworkAdapter {
    readonly id: string;
    readonly label: string;
    readonly kinds: readonly TestKind[];
    readonly alsoRenders?: readonly TestKind[];
    readonly executable: boolean;
    readonly runtime: string;
    readonly needs: RunnerNeeds;
    readonly traits: AdapterTraits;

    constructor(
        private readonly inner: ShapedAdapter,
        label: string,
        readonly plugin: { name: string; version: string },
    ) {
        this.id = inner.id;
        this.label = label;
        this.kinds = Object.freeze([...inner.kinds]);
        if (inner.alsoRenders) this.alsoRenders = Object.freeze([...inner.alsoRenders]);
        this.executable = inner.executable;
        this.runtime = inner.runtime;
        this.needs = Object.freeze({ ...inner.needs, ...(inner.needs.browsers ? { browsers: Object.freeze([...inner.needs.browsers]) as RunnerNeeds["browsers"] } : {}) }) as RunnerNeeds;
        this.traits = Object.freeze({ ...inner.traits });
    }

    private who(): string {
        return `The plug-in "${this.plugin.name}"`;
    }

    render(spec: TestSpec, ctx: RenderContext): GeneratedScript {
        if (!this.kinds.includes(spec.kind) && !this.alsoRenders?.includes(spec.kind)) throw new Error(`${this.label} does not run ${spec.kind} tests.`);
        // Stored sign-in details only go to the application's own site. The spec arrives here with its reusable steps already expanded
        // (renderWithAdapter), so the rule is checked on the steps the plug-in will really see, before it sees them.
        assertCredentialsStayHome(spec, ctx);
        let script: GeneratedScript;
        try {
            // Copies, so a plug-in cannot change the test or the platform's objects while it renders.
            const specCopy = structuredClone(spec);
            let ctxCopy: RenderContext;
            try {
                ctxCopy = structuredClone(ctx);
            } catch {
                ctxCopy = { baseUrl: ctx.baseUrl, ...(ctx.apiBaseUrl ? { apiBaseUrl: ctx.apiBaseUrl } : {}) };
            }
            script = sanitizeScript(this.inner.render(specCopy, ctxCopy, renderHost), this.id);
        } catch (e) {
            throw new Error(`${this.who()} could not render this test: ${errorText(e)}`);
        }
        return script;
    }

    async execute(batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions): Promise<ScriptRun[]> {
        if (opts.signal?.aborted) throw new Error("Job cancelled");
        const scripts = batch.scripts;
        if (scripts.length === 0) return [];
        if (!this.executable) return infrastructureRuns(scripts, `${this.label} is stored here but this platform does not run it.`);
        let secrets: string[] = [];
        try {
            secrets = secretsOfRun(env.run);
        } catch {
            /* masking is best effort */
        }
        const limitMs = opts.timeoutMs ?? Math.max(120_000, scripts.length * (opts.testTimeoutMs ?? 60_000));
        // The plug-in's own signal: aborted when the run is cancelled or the time is up, so its child processes can be stopped.
        const own = new AbortController();
        let timer: NodeJS.Timeout | undefined;
        let onParentAbort: (() => void) | undefined;
        const stop = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                own.abort();
                reject(new Stopped("timeout"));
            }, limitMs);
            onParentAbort = () => {
                own.abort();
                reject(new Stopped("cancel"));
            };
            opts.signal?.addEventListener("abort", onParentAbort, { once: true });
        });
        stop.catch(() => undefined);
        const created: string[] = [];
        try {
            const copy: ExecutionBatch = { scratchDir: batch.scratchDir, scripts: structuredClone(scripts) };
            const call = Promise.resolve().then(() => this.inner.execute(copy, { ...env }, { ...opts, signal: own.signal }, execHost(batch.scratchDir, created)));
            call.catch(() => undefined); // a late failure after the race is decided is not news
            const raw = await Promise.race([call, stop]);
            const runs = sanitizeRuns(raw, scripts, batch.scratchDir, secrets, this.who());
            // The folders the plug-in made are removed now, except those that hold a file the platform still has to copy (a screenshot).
            await removeFolders(created, runs);
            return runs;
        } catch (e) {
            await removeFolders(created);
            if (e instanceof Stopped) {
                if (e.why === "cancel") throw new Error("Job cancelled");
                return infrastructureRuns(scripts, `${this.who()} did not finish within ${Math.round(limitMs / 1000)} seconds and was stopped.`);
            }
            return infrastructureRuns(scripts, maskSecrets(`${this.who()} stopped with an error: ${errorText(e)}`, secrets));
        } finally {
            clearTimeout(timer);
            if (onParentAbort) opts.signal?.removeEventListener("abort", onParentAbort);
        }
    }

    describe(): AdapterDescription {
        return { id: this.id, label: this.label, kinds: [...this.kinds], executable: this.executable, runtime: this.runtime, needs: { ...this.needs, ...(this.needs.browsers ? { browsers: [...this.needs.browsers] } : {}) }, traits: { ...this.traits }, plugin: { ...this.plugin } };
    }
}

// ── loading ──────────────────────────────────────────────────────────────────

export interface PluginProblem {
    /** The plug-in's name from plugin.json, or the file or folder name when that could not be read. Never a full path. */
    plugin: string;
    message: string;
}

export interface LoadedPlugin {
    name: string;
    version: string;
    description: string;
    adapters: Array<{ id: string; label: string }>;
}

export interface PluginStatus {
    /** ALLOW_ADAPTER_PLUGINS=true was set. */
    requested: boolean;
    /** Plug-ins are loaded (requested and API_KEY set). */
    enabled: boolean;
    /** How many entries ADAPTER_PLUGINS lists. */
    configured: number;
    /** Why plug-ins are not loaded although something asked for them (set only then). */
    reason?: string;
    loaded: LoadedPlugin[];
    problems: PluginProblem[];
}

export interface LoadPluginsOptions {
    /** The effective switch (ALLOW_ADAPTER_PLUGINS with an API_KEY). */
    enabled: boolean;
    /** The switch as asked for. */
    requested: boolean;
    /** Why a requested switch is not in force. */
    reason?: string;
    /** The ADAPTER_PLUGINS value. */
    list: string | undefined;
    /** Where to register (default: the platform's registry). */
    registry?: AdapterRegistry;
    /** Replace `import()` (tests). */
    importModule?: (url: string) => Promise<unknown>;
    /** How long importing a module may take. */
    importTimeoutMs?: number;
}

const initial = (): PluginStatus => ({ requested: false, enabled: false, configured: 0, loaded: [], problems: [] });
let status: PluginStatus = initial();
/** Adapters this loader registered, so they can be removed again (tests, reload). */
let registered: Array<{ id: string; registry: AdapterRegistry }> = [];
/** Adapter ids declared by a plug-in that did not load, with why: used to explain a test whose framework is missing. */
let failedIds = new Map<string, { plugin: string; message: string }>();

export const getPluginStatus = (): PluginStatus => ({ ...status, loaded: status.loaded.map((p) => ({ ...p, adapters: [...p.adapters] })), problems: status.problems.map((p) => ({ ...p })) });

/** Remove the adapters this loader added and forget the status. */
export function unloadPlugins(): void {
    for (const r of registered) r.registry.unregister(r.id);
    registered = [];
    failedIds = new Map();
    status = initial();
}

const withTimeout = <T>(p: Promise<T>, ms: number, message: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(message)), ms);
        p.then(
            (v) => (clearTimeout(t), resolve(v)),
            (e) => (clearTimeout(t), reject(e)),
        );
    });

async function statOrUndefined(p: string) {
    try {
        return await fs.stat(p);
    } catch {
        return undefined;
    }
}

/** Where a plug-in's manifest and module are, given the path the owner listed. */
async function locate(file: string): Promise<{ ok: true; manifest: string; entry: string } | { ok: false; message: string }> {
    const name = displayName(file);
    const real = await fs.realpath(file).catch(() => undefined);
    const st = real ? await statOrUndefined(real) : undefined;
    if (!real || !st) return { ok: false, message: `Nothing was found at "${name}".` };
    if (st.isDirectory()) {
        const manifest = path.join(real, "plugin.json");
        const entry = path.join(real, "adapter.mjs");
        if (!(await statOrUndefined(manifest))?.isFile()) return { ok: false, message: `The folder "${name}" has no plugin.json.` };
        if (!(await statOrUndefined(entry))?.isFile()) return { ok: false, message: `The folder "${name}" has no adapter.mjs.` };
        return { ok: true, manifest, entry };
    }
    const ext = path.extname(real).toLowerCase();
    if (ext !== ".mjs" && ext !== ".js") return { ok: false, message: `"${name}" is not a .mjs or .js file or a folder.` };
    const manifest = real.slice(0, -ext.length) + ".plugin.json";
    if (!(await statOrUndefined(manifest))?.isFile()) return { ok: false, message: `A single-file plug-in needs a manifest next to it called "${path.basename(manifest)}".` };
    return { ok: true, manifest, entry: real };
}

/** Load the plug-ins the owner listed. Never throws: every problem lands in the returned status, and other plug-ins and the built-ins keep working. */
export async function loadPlugins(o: LoadPluginsOptions): Promise<PluginStatus> {
    unloadPlugins();
    const registry = o.registry ?? sharedRegistry;
    const entries = splitPluginList(o.list);
    const next: PluginStatus = { requested: o.requested, enabled: o.enabled, configured: entries.length, loaded: [], problems: [] };
    if (!o.enabled) {
        // Off: nothing on disk is opened, so nothing a module would do when imported can happen.
        if (o.reason) next.reason = o.reason;
        else if (entries.length > 0) next.reason = "ADAPTER_PLUGINS lists plug-ins, but ALLOW_ADAPTER_PLUGINS is not true, so none is loaded (the default).";
        status = next;
        return getPluginStatus();
    }
    const importModule = o.importModule ?? ((url: string) => import(url));
    const importTimeoutMs = o.importTimeoutMs ?? 10_000;
    const problem = (plugin: string, message: string, ids: string[] = []) => {
        next.problems.push({ plugin, message });
        for (const id of ids) failedIds.set(id, { plugin, message });
    };

    // The ids of the frameworks that ship with the platform, whichever registry the plug-ins are added to.
    const builtIns = new Set(sharedRegistry.list().filter((a) => isBuiltInAdapterId(a.id)).map((a) => a.id));
    for (const [i, raw] of entries.entries()) {
        const label = displayName(raw);
        if (i >= PLUGIN_LIMITS.plugins) {
            problem(label, `Only ${PLUGIN_LIMITS.plugins} plug-ins are loaded; this one was left out.`);
            continue;
        }
        const checked = checkPluginPath(raw);
        if (!checked.ok) {
            problem(label, checked.message);
            continue;
        }
        const where = await locate(checked.path);
        if (!where.ok) {
            problem(label, where.message);
            continue;
        }
        // The manifest is read and judged before the module is imported: a plug-in that fails it never runs.
        let manifest: PluginManifest;
        try {
            const size = (await fs.stat(where.manifest)).size;
            if (size > PLUGIN_LIMITS.manifestBytes) {
                problem(label, `plugin.json is larger than ${PLUGIN_LIMITS.manifestBytes / 1024} KB.`);
                continue;
            }
            const parsed = parseManifest(await fs.readFile(where.manifest, "utf8"), builtIns);
            if (!parsed.ok) {
                problem(label, parsed.message);
                continue;
            }
            manifest = parsed.manifest;
        } catch (e) {
            problem(label, `plugin.json could not be read: ${errorText(e)}`);
            continue;
        }
        const ids = manifest.adapters.map((a) => a.id);
        const clash = ids.find((id) => registry.has(id));
        if (clash) {
            problem(manifest.name, `The adapter id "${clash}" is already in use.`, ids);
            continue;
        }

        let objects: unknown[];
        try {
            const mod = (await withTimeout(Promise.resolve(importModule(pathToFileURL(where.entry).href)), importTimeoutMs, `Loading took longer than ${importTimeoutMs / 1000} seconds.`)) as Record<string, unknown> | null;
            let exported: unknown = mod?.default ?? mod?.adapters;
            if (typeof exported === "function") exported = await withTimeout(Promise.resolve((exported as (host: PluginRenderHost) => unknown)(renderHost)), importTimeoutMs, `Starting the plug-in took longer than ${importTimeoutMs / 1000} seconds.`);
            objects = Array.isArray(exported) ? exported : exported === undefined || exported === null ? [] : [exported];
        } catch (e) {
            problem(manifest.name, `The plug-in could not be loaded: ${errorText(e)}`, ids);
            continue;
        }

        const shaped: ShapedAdapter[] = [];
        let bad: string | undefined;
        for (const m of manifest.adapters) {
            const obj = objects.find((x) => x !== null && typeof x === "object" && (x as { id?: unknown }).id === m.id);
            if (obj === undefined) {
                bad = `plugin.json declares the adapter "${m.id}", but the plug-in does not provide it.`;
                break;
            }
            const r = checkAdapterShape(obj, m.id);
            if (!r.ok) {
                bad = r.message;
                break;
            }
            shaped.push(r.adapter);
        }
        if (!bad && objects.length > manifest.adapters.length) bad = "The plug-in provides an adapter that plugin.json does not declare.";
        if (bad) {
            problem(manifest.name, bad, ids);
            continue;
        }

        // Register all of this plug-in's adapters or none.
        const done: string[] = [];
        try {
            for (const [k, s] of shaped.entries()) {
                registry.register(new PluginAdapter(s, manifest.adapters[k]!.label, { name: manifest.name, version: manifest.version }));
                done.push(s.id);
            }
        } catch (e) {
            for (const id of done) registry.unregister(id);
            problem(manifest.name, `The plug-in could not be registered: ${errorText(e)}`, ids);
            continue;
        }
        for (const id of done) registered.push({ id, registry });
        next.loaded.push({ name: manifest.name, version: manifest.version, description: manifest.description, adapters: manifest.adapters.map((a) => ({ id: a.id, label: a.label })) });
    }
    status = next;
    return getPluginStatus();
}

/** The shape of the settings the loader needs from the platform's configuration (see config.ts). */
export interface PluginConfig {
    ALLOW_ADAPTER_PLUGINS: boolean;
    ADAPTER_PLUGINS?: string | undefined;
    adapterPluginsRequested: boolean;
    adapterPluginsReason?: string | undefined;
}

/** Load plug-ins as the configuration says, and say loudly what is on. Called once at start, before the server accepts requests. */
export async function loadConfiguredPlugins(config: PluginConfig, log: Pick<Console, "warn" | "log"> = console): Promise<PluginStatus> {
    const result = await loadPlugins({ enabled: config.ALLOW_ADAPTER_PLUGINS === true, requested: config.adapterPluginsRequested, ...(config.adapterPluginsReason ? { reason: config.adapterPluginsReason } : {}), list: config.ADAPTER_PLUGINS });
    if (config.adapterPluginsReason) log.warn(`[security] ${config.adapterPluginsReason}`);
    else if (result.reason) log.warn(`[plugins] ${result.reason}`);
    if (result.enabled) {
        log.warn(`[security] ALLOW_ADAPTER_PLUGINS is on: ${result.loaded.length} plug-in${result.loaded.length === 1 ? "" : "s"} loaded. A plug-in runs inside this server with all its power (it can read every secret a run is given and reach the database). Only load plug-ins you wrote or reviewed.`);
        for (const p of result.loaded) log.log(`[plugins] ${p.name} ${p.version}: ${p.adapters.map((a) => a.id).join(", ")}`);
    }
    for (const p of result.problems) log.warn(`[plugins] ${p.plugin}: ${p.message}`);
    return result;
}

/**
 * A sentence for a test whose framework no adapter serves now (a plug-in that was removed, failed to load, or is switched off).
 * Used by the job gate and the job runner; plain words, no stack trace, says nothing was deleted.
 */
export function explainMissingFramework(id: string): string {
    const failed = failedIds.get(id);
    const why = failed
        ? `The plug-in "${failed.plugin}" did not load: ${failed.message}`
        : status.reason
          ? status.reason
          : !status.enabled
            ? "Adapter plug-ins are turned off (ALLOW_ADAPTER_PLUGINS is not true)."
            : "No plug-in listed in ADAPTER_PLUGINS provides it.";
    return `Some tests use the testing framework "${id}", which an adapter plug-in provides and which is not loaded now. ${why} Nothing was deleted: the tests and their results are kept, and they run again once the plug-in is loaded.`;
}
