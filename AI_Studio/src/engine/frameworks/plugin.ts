/**
 * Adapter plug-ins, the pure part: what a plug-in's manifest may say, what a loaded adapter object must look like, which paths may be
 * listed, and how an answer coming back from a plug-in is cleaned before the platform believes it. No file or process access beyond
 * `fs.realpathSync` on artifact paths; the loading itself is in plugin-loader.ts.
 *
 * A plug-in is code that runs inside the platform process. Nothing here makes it safe: it keeps a careless plug-in from corrupting
 * what the platform stores (a bad status, a huge string, a path outside the run folder) and keeps a broken one from stopping the
 * platform. Only load plug-ins you wrote or reviewed (docs/features/adapter-plugins.md).
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { TEST_KINDS, type TestKind } from "../spec/schema.js";
import type { AdapterTraits, ExecutionBatch, ExecutionEnv, ExecutionOptions, GeneratedScript, RenderContext, RunnerNeeds, ScriptRun } from "./types.js";
import type { TestSpec } from "../spec/schema.js";

export const PLUGIN_API_VERSION = 1;

/** Caps on everything that comes from a plug-in or from the list of plug-ins. */
export const PLUGIN_LIMITS = {
    plugins: 10,
    adaptersPerPlugin: 5,
    manifestBytes: 16 * 1024,
    pathChars: 500,
    scriptBytes: 1_000_000,
    filenameChars: 120,
    errorChars: 4_000,
    stepErrorChars: 2_000,
    titleChars: 300,
    steps: 500,
    artifacts: 20,
    responses: 500,
    notes: 20,
    noteChars: 500,
    metrics: 50,
    maxDurationMs: 24 * 3_600_000,
} as const;

export const ADAPTER_ID = /^[a-z][a-z0-9-]{1,30}$/;
const RUNTIME = /^[a-z][a-z0-9-]{1,40}$/;
/** Runtimes of the built-in frameworks: a plug-in sharing one would have its scripts handed to (or taken over by) a built-in adapter. */
export const BUILT_IN_RUNTIMES: readonly string[] = ["playwright", "taqwright", "windows-uia", "taqwright-ios"];

// ── manifest ─────────────────────────────────────────────────────────────────

export const ManifestSchema = z
    .object({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,48}$/, "name must be 1-49 letters, digits, spaces, dots, dashes or underscores, starting with a letter or digit"),
        version: z.string().min(1).max(30),
        apiVersion: z.literal(PLUGIN_API_VERSION, { error: () => `apiVersion must be ${PLUGIN_API_VERSION}` }),
        description: z.string().max(300).default(""),
        adapters: z
            .array(z.object({ id: z.string().regex(ADAPTER_ID, "an adapter id is 2-31 lower-case letters, digits or dashes, starting with a letter"), label: z.string().min(1).max(80) }).strict())
            .min(1, "list at least one adapter")
            .max(PLUGIN_LIMITS.adaptersPerPlugin, `a plug-in may add at most ${PLUGIN_LIMITS.adaptersPerPlugin} adapters`),
    })
    .strict();
export type PluginManifest = z.infer<typeof ManifestSchema>;

const issueText = (e: z.ZodError): string =>
    e.issues
        .slice(0, 3)
        .map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`)
        .join("; ");

/** Parse and check plugin.json. Plain message on failure (it reaches GET /api/config). */
export function parseManifest(text: string, builtInIds: ReadonlySet<string> = new Set()): { ok: true; manifest: PluginManifest } | { ok: false; message: string } {
    if (Buffer.byteLength(text) > PLUGIN_LIMITS.manifestBytes) return { ok: false, message: `plugin.json is larger than ${PLUGIN_LIMITS.manifestBytes / 1024} KB.` };
    // A byte order mark at the start (PowerShell and some editors write one) is not part of the JSON.
    text = text.replace(/^﻿/, "");
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false, message: "plugin.json is not valid JSON." };
    }
    const r = ManifestSchema.safeParse(raw);
    if (!r.success) return { ok: false, message: `plugin.json is not valid: ${issueText(r.error)}.` };
    const seen = new Set<string>();
    for (const a of r.data.adapters) {
        if (builtInIds.has(a.id)) return { ok: false, message: `The adapter id "${a.id}" belongs to a framework that ships with the platform. A plug-in cannot replace it; choose another id.` };
        if (seen.has(a.id)) return { ok: false, message: `plugin.json lists the adapter id "${a.id}" twice.` };
        seen.add(a.id);
    }
    return { ok: true, manifest: r.data };
}

// ── the adapter object a plug-in hands over ──────────────────────────────────

const KindList = z.array(z.enum(TEST_KINDS)).min(1).max(TEST_KINDS.length);
const NeedsSchema = z
    .object({
        node: z.boolean(),
        browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).max(3).optional(),
        android: z.boolean().optional(),
        ios: z.boolean().optional(),
        windows: z.boolean().optional(),
    })
    .strict();
const TraitsSchema = z.object({ visionJudgement: z.boolean(), cleanupLedger: z.boolean(), browserRepair: z.boolean() }).strict();

/** What the platform keeps of a plug-in's adapter: plain copies of the data, plus the two functions it may call. */
export interface ShapedAdapter {
    id: string;
    label: string;
    kinds: TestKind[];
    alsoRenders?: TestKind[];
    executable: boolean;
    runtime: string;
    needs: RunnerNeeds;
    traits: AdapterTraits;
    render: (spec: TestSpec, ctx: RenderContext, host: unknown) => unknown;
    execute: (batch: ExecutionBatch, env: ExecutionEnv, opts: ExecutionOptions, host: unknown) => Promise<unknown> | unknown;
}

/** Check one adapter object against the contract (every required member and its type). `id` is the one the manifest declared for it. */
export function checkAdapterShape(obj: unknown, expectedId: string): { ok: true; adapter: ShapedAdapter } | { ok: false; message: string } {
    const where = `The adapter "${expectedId}"`;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, message: `${where} is not an object.` };
    const o = obj as Record<string, unknown>;
    try {
        if (o.id !== expectedId) return { ok: false, message: `${where}: the object's id is ${typeof o.id === "string" ? `"${o.id.slice(0, 40)}"` : "missing"}, but plugin.json declares "${expectedId}".` };
        const label = z.string().min(1).max(80).safeParse(o.label);
        if (!label.success) return { ok: false, message: `${where} needs a label of 1-80 characters.` };
        const kinds = KindList.safeParse(o.kinds);
        if (!kinds.success) return { ok: false, message: `${where} needs "kinds": a list of ${TEST_KINDS.map((k) => `"${k}"`).join(", ")}.` };
        const also = o.alsoRenders === undefined ? undefined : KindList.safeParse(o.alsoRenders);
        if (also && !also.success) return { ok: false, message: `${where}: "alsoRenders" must be a list of test kinds.` };
        if (typeof o.executable !== "boolean") return { ok: false, message: `${where} needs "executable" to be true or false.` };
        const runtime = z.string().regex(RUNTIME).safeParse(o.runtime);
        if (!runtime.success) return { ok: false, message: `${where} needs a "runtime" of 2-41 lower-case letters, digits or dashes.` };
        if (BUILT_IN_RUNTIMES.includes(runtime.data)) return { ok: false, message: `${where}: the runtime "${runtime.data}" belongs to a framework that ships with the platform. Use a name of your own.` };
        const needs = NeedsSchema.safeParse(o.needs);
        if (!needs.success) return { ok: false, message: `${where} needs "needs" like { node: true } (${issueText(needs.error)}).` };
        const traits = TraitsSchema.safeParse(o.traits);
        if (!traits.success) return { ok: false, message: `${where} needs "traits" with visionJudgement, cleanupLedger and browserRepair, each true or false.` };
        if (typeof o.render !== "function") return { ok: false, message: `${where} needs a render(spec, ctx) function.` };
        if (typeof o.execute !== "function") return { ok: false, message: `${where} needs an execute(batch, env, opts) function.` };
        if (o.describe !== undefined && typeof o.describe !== "function") return { ok: false, message: `${where}: "describe" must be a function when present (the platform builds the description itself and never calls it).` };
        const render = o.render as ShapedAdapter["render"];
        const execute = o.execute as ShapedAdapter["execute"];
        return {
            ok: true,
            adapter: {
                id: expectedId,
                label: label.data,
                kinds: [...new Set(kinds.data)],
                ...(also?.success ? { alsoRenders: [...new Set(also.data)] } : {}),
                executable: o.executable,
                runtime: runtime.data,
                needs: { ...needs.data, ...(needs.data.browsers ? { browsers: [...needs.data.browsers] } : {}) },
                traits: { ...traits.data },
                // Called as methods of the plug-in's own object, so a class-based adapter keeps its `this`.
                render: (spec, ctx, host) => render.call(o, spec, ctx, host),
                execute: (batch, env, opts, host) => execute.call(o, batch, env, opts, host),
            },
        };
    } catch (e) {
        // A getter that throws, a hostile proxy: the adapter is not usable.
        return { ok: false, message: `${where} could not be read: ${errorText(e)}` };
    }
}

// ── paths ────────────────────────────────────────────────────────────────────

/** The last segment of a path as written, for messages: a plug-in is named by its file or folder, never by a full server path. */
export function displayName(raw: string): string {
    const last = raw.split(/[\\/]+/).filter(Boolean).pop() ?? raw;
    return last.slice(0, 60);
}

/** One entry of ADAPTER_PLUGINS, judged by its text alone (nothing on disk is touched). */
export function checkPluginPath(raw: string): { ok: true; path: string } | { ok: false; message: string } {
    const name = displayName(raw);
    if (raw.length > PLUGIN_LIMITS.pathChars) return { ok: false, message: `A path in ADAPTER_PLUGINS is longer than ${PLUGIN_LIMITS.pathChars} characters.` };
    if (raw.includes("\0")) return { ok: false, message: `The path ending in "${name}" is not valid.` };
    if (/^[\\/]{2}/.test(raw)) return { ok: false, message: `"${name}": network paths (\\\\server\\share) are not accepted. Copy the plug-in to a local folder.` };
    if (raw.split(/[\\/]+/).includes("..")) return { ok: false, message: `"${name}": a path with ".." in it is not accepted. Write the full path.` };
    const absolute = process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(raw) : raw.startsWith("/");
    if (!absolute) return { ok: false, message: `"${name}": write the full (absolute) path to the plug-in, not a relative one.` };
    return { ok: true, path: path.resolve(raw) };
}

/** Split the ADAPTER_PLUGINS value into entries (semicolon-separated; empty parts ignored). */
export function splitPluginList(value: string | undefined): string[] {
    return (value ?? "")
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
}

// ── answers coming back from a plug-in ───────────────────────────────────────

// A path in a message: a Windows drive path (folders may hold spaces, the file name may not), a network path, a file: address, a POSIX absolute path.
const PATH_IN_TEXT = new RegExp(
    [
        String.raw`(?:file:\/\/\/?)?[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\s'()]*`,
        String.raw`\\\\[^\s'"<>()|]+`,
        String.raw`file:\/\/[^\s'"<>()|]+`,
        // Only under the usual roots: a web address such as /api/notes/5 in an error is not a place on this server.
        String.raw`(?<![\w.:/\\-])\/(?:home|Users|root|var|tmp|opt|srv|usr|mnt|app|data|etc|private|workspace|builds?)\/(?:[\w.@~+ -]+\/)*[\w.@~+-]*`,
    ].join("|"),
    "g",
);

/**
 * The text with every full path cut down to its last part ("Cannot find package 'x' imported from C:\Users\me\p\adapter.mjs" becomes
 * "... imported from adapter.mjs"): messages reach the API and the screen, which show names and file names, never where the server keeps things.
 */
export function hidePaths(text: string): string {
    return text.replace(PATH_IN_TEXT, (m) => m.split(/[\\/]+/).filter(Boolean).pop() ?? "<path>");
}

/** Text of any thrown value, short and single-spaced, with no server path in it. Never a stack trace. */
export function errorText(e: unknown, max = 300): string {
    const m = e instanceof Error ? e.message : typeof e === "string" ? e : "unknown error";
    return hidePaths(m.replace(/\s+/g, " ").trim()).slice(0, max) || "unknown error";
}

/** Replace every secret of the run (exact text) in a string. Short strings are not secrets worth masking. */
export function maskSecrets(text: string, secrets: readonly string[]): string {
    let out = text;
    for (const s of secrets) if (s.length >= 4 && out.includes(s)) out = out.split(s).join("[hidden]");
    return out;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Windows opens the console, a printer or a null device for these names (with or without an extension: "con.mjs" is "con"), and ignores a trailing dot. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|clock\$|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
export const isReservedFileName = (name: string): boolean => name.endsWith(".") || WINDOWS_DEVICE.test(name.split(".")[0]!);

/** Check the script a plug-in rendered. Throws a plain Error. The framework is always the adapter's own id. */
export function sanitizeScript(raw: unknown, adapterId: string): GeneratedScript {
    if (raw !== null && typeof raw === "object" && typeof (raw as { then?: unknown }).then === "function") throw new Error("render() must return the script itself, not a promise.");
    if (raw === null || typeof raw !== "object") throw new Error("render() must return { filename, content }.");
    const o = raw as Record<string, unknown>;
    const filename = o.filename;
    if (typeof filename !== "string" || filename.length > PLUGIN_LIMITS.filenameChars || !SAFE_FILENAME.test(filename) || filename.includes("..") || isReservedFileName(filename)) throw new Error("render() returned a file name that is not allowed (letters, digits, dots, dashes and underscores only, no folders, no name Windows keeps for devices such as con, nul or com1, no dot at the end).");
    const content = o.content;
    if (typeof content !== "string") throw new Error("render() must return the script text as a string.");
    if (Buffer.byteLength(content) > PLUGIN_LIMITS.scriptBytes) throw new Error(`The script is larger than ${PLUGIN_LIMITS.scriptBytes / 1_000_000} MB.`);
    return { framework: adapterId, filename, content, language: "typescript" };
}

const RUN_STATUS = new Set<ScriptRun["status"]>(["passed", "failed", "timedOut", "skipped", "error"]);
const ARTIFACT_KINDS = new Set(["screenshot", "trace", "video"]);

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
const int = (v: unknown, min: number, max: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : undefined);

/** True when `file` is inside `dir` (after resolving), not equal to it. */
export function isInside(dir: string, file: string): boolean {
    const rel = path.relative(path.resolve(dir), path.resolve(file));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

const infra = (testId: string, error: string): ScriptRun => ({ testId, status: "error", durationMs: 0, error, failedStepIndex: -1, steps: [], artifacts: [], responses: [] });

/** The result for every script when the plug-in could not run them: an infrastructure error, never a pass. */
export const infrastructureRuns = (scripts: ReadonlyArray<{ testId: string }>, message: string): ScriptRun[] => scripts.map((s) => infra(s.testId, message));

/**
 * Clean what execute() returned. One result per script, in input order, each rebuilt field by field from a fresh object (nothing from
 * the plug-in's object is spread or kept, so a `__proto__` key or an odd getter cannot reach the platform). A malformed answer for one
 * script becomes an error for that script; a wrong count becomes an error for all.
 */
export function sanitizeRuns(raw: unknown, scripts: ReadonlyArray<{ testId: string }>, scratchDir: string, secrets: readonly string[], who = "The plug-in"): ScriptRun[] {
    if (!Array.isArray(raw)) return infrastructureRuns(scripts, `${who} did not return a list of results.`);
    if (raw.length !== scripts.length) return infrastructureRuns(scripts, `${who} returned ${raw.length} result${raw.length === 1 ? "" : "s"} for ${scripts.length} script${scripts.length === 1 ? "" : "s"}.`);
    const mask = (s: string) => maskSecrets(s, secrets);
    return scripts.map((script, index) => {
        try {
            const r = raw[index] as Record<string, unknown> | null;
            if (r === null || typeof r !== "object") return infra(script.testId, `${who} returned no result for this script.`);
            const status = r.status as ScriptRun["status"];
            if (!RUN_STATUS.has(status)) return infra(script.testId, `${who} reported a status the platform does not know.`);
            const notes: string[] = [];
            const error = str(r.error, PLUGIN_LIMITS.errorChars);
            const steps = (Array.isArray(r.steps) ? r.steps.slice(0, PLUGIN_LIMITS.steps) : []).flatMap((s, i) => {
                const o = s as Record<string, unknown> | null;
                if (o === null || typeof o !== "object" || (o.status !== "passed" && o.status !== "failed")) return [];
                const stepError = str(o.error, PLUGIN_LIMITS.stepErrorChars);
                return [{ index: int(o.index, 0, 100_000) ?? i, title: mask(str(o.title, PLUGIN_LIMITS.titleChars) ?? `Step ${i + 1}`), status: o.status as "passed" | "failed", ...(stepError !== undefined ? { error: mask(stepError) } : {}) }];
            });
            const artifacts: ScriptRun["artifacts"] = [];
            for (const a of (Array.isArray(r.artifacts) ? r.artifacts : []).slice(0, PLUGIN_LIMITS.artifacts)) {
                const o = a as Record<string, unknown> | null;
                if (o === null || typeof o !== "object" || typeof o.path !== "string" || typeof o.kind !== "string" || !ARTIFACT_KINDS.has(o.kind)) continue;
                try {
                    const real = fs.realpathSync(o.path);
                    // Where the path really points (links followed) must be inside the folder this batch may use.
                    if (!isInside(fs.realpathSync(scratchDir), real)) {
                        notes.push("A file the plug-in named was outside the run folder and was left out.");
                        continue;
                    }
                    artifacts.push({ kind: o.kind as "screenshot" | "trace" | "video", path: real });
                } catch {
                    notes.push("A file the plug-in named does not exist and was left out.");
                }
            }
            const responses = (Array.isArray(r.responses) ? r.responses : []).slice(0, PLUGIN_LIMITS.responses).flatMap((x) => {
                const o = x as Record<string, unknown> | null;
                const method = o && typeof o === "object" ? str(o.method, 16) : undefined;
                const p = o && typeof o === "object" ? str(o.path, 500) : undefined;
                const st = o && typeof o === "object" ? int(o.status, 0, 999) : undefined;
                return method !== undefined && p !== undefined && st !== undefined ? [{ method, path: mask(p), status: st }] : [];
            });
            const metrics = (Array.isArray(r.metrics) ? r.metrics : []).slice(0, PLUGIN_LIMITS.metrics).flatMap((x) => {
                const o = x as Record<string, unknown> | null;
                if (o === null || typeof o !== "object" || typeof o.value !== "number" || !Number.isFinite(o.value)) return [];
                const metric = str(o.metric, 60);
                const unit = str(o.unit, 20);
                return metric !== undefined && unit !== undefined ? [{ metric, value: o.value, unit, ...(typeof o.budget === "number" && Number.isFinite(o.budget) ? { budget: o.budget } : {}) }] : [];
            });
            for (const n of (Array.isArray(r.notes) ? r.notes : []).slice(0, PLUGIN_LIMITS.notes)) {
                const t = str(n, PLUGIN_LIMITS.noteChars);
                if (t) notes.push(mask(t));
            }
            const run: ScriptRun = {
                testId: script.testId,
                status,
                durationMs: int(r.durationMs, 0, PLUGIN_LIMITS.maxDurationMs) ?? 0,
                ...(error !== undefined ? { error: mask(error) } : {}),
                failedStepIndex: int(r.failedStepIndex, -1, 100_000) ?? -1,
                steps,
                artifacts,
                responses,
                ...(metrics.length ? { metrics } : {}),
                ...(notes.length ? { notes: notes.slice(0, PLUGIN_LIMITS.notes) } : {}),
            };
            // A failure with no words would leave the person guessing.
            if ((status === "failed" || status === "error" || status === "timedOut") && !run.error && !run.steps.some((s) => s.error)) run.error = `${who} reported a failure without saying why.`;
            return run;
        } catch (e) {
            return infra(script.testId, `${who} returned a result the platform could not read (${errorText(e, 120)}).`);
        }
    });
}
