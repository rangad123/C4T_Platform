/**
 * Runner agents, the pure parts (no database, no network): which requests belong to the agent protocol, what an agent
 * must have to run a framework, how a run's environment crosses the wire, and the small safety helpers (path anchoring,
 * secret scrubbing, rate limiting). Everything here is unit-tested without a server.
 */
import path from "node:path";
import { AGENT_TOKEN_PREFIX, SafeName, WireRunEnv, type Capabilities } from "../agent-protocol/schema.js";
import type { RunEnv } from "../engine/validation/runner.js";
import type { RunnerNeeds } from "../engine/frameworks/types.js";
import { iosCapabilityProblem } from "../engine/mobile/ios-capability.js";

// ── the device a task holds ──────────────────────────────────────────────────

/**
 * The phone, emulator or simulator a task will use on its runner, read from the offer: a named device, or "*" when the runner picks
 * (it then holds all of that kind, because the platform cannot know which one it takes). A task that uses no device: undefined.
 */
export function deviceNeedOf(offer: { adapterId: string; kind?: string; mobile?: { deviceSerial?: string; avd?: string; runsOn?: { kind: string; serial?: string }; exploredOn?: { serial: string } }; ios?: { simulator?: string; defaultSimulator?: string }; device?: { deviceSerial?: string; avd?: string } }): { family: "android" | "ios"; device: string } | undefined {
    if (offer.kind === "device") {
        const d = offer.device;
        return { family: "android", device: d?.deviceSerial ?? (d?.avd ? `avd:${d.avd}` : "*") };
    }
    if (offer.adapterId === "taqwright-ios") return { family: "ios", device: offer.ios?.simulator ?? offer.ios?.defaultSimulator ?? "*" };
    if (offer.adapterId !== "taqwright") return undefined;
    const m = offer.mobile;
    const kind = m?.runsOn?.kind;
    const named = m?.deviceSerial ?? (kind === "phone" || kind === "explored" ? (m?.runsOn?.serial ?? (kind === "explored" ? m?.exploredOn?.serial : undefined)) : undefined);
    return { family: "android", device: named ?? (kind === "emulator" || !kind ? (m?.avd ? `avd:${m.avd}` : "*") : "*") };
}

// ── the six agent routes ─────────────────────────────────────────────────────

const ID = "[A-Za-z0-9-]{8,64}";
const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,119}";
const ROUTES: Array<{ method: string; kind: AgentRoute["kind"]; re: RegExp }> = [
    { method: "POST", kind: "hello", re: /^\/api\/agent\/hello$/ },
    { method: "POST", kind: "poll", re: /^\/api\/agent\/poll$/ },
    { method: "POST", kind: "heartbeat", re: new RegExp(`^/api/agent/tasks/(${ID})/heartbeat$`) },
    { method: "GET", kind: "download", re: new RegExp(`^/api/agent/tasks/(${ID})/files/(${NAME})$`) },
    { method: "PUT", kind: "upload", re: new RegExp(`^/api/agent/tasks/(${ID})/files/(${NAME})$`) },
    { method: "POST", kind: "result", re: new RegExp(`^/api/agent/tasks/(${ID})/result$`) },
    // Record tasks only: the agent pushes the state of a recording (added with recording on an agent).
    { method: "POST", kind: "recording", re: new RegExp(`^/api/agent/tasks/(${ID})/recording$`) },
    // Device tasks only: the agent pushes the state of a phone session and the answers to the explorer's commands (AI phone exploration).
    { method: "POST", kind: "device", re: new RegExp(`^/api/agent/tasks/(${ID})/device$`) },
    // Runner updates: what to update to, and the files of that update (docs/features/runner-updates.md). The empty group keeps the name in m[2].
    { method: "POST", kind: "update", re: /^\/api\/agent\/update$/ },
    { method: "GET", kind: "update-file", re: new RegExp(`^/api/agent/update/files/()(${NAME})$`) },
    // "Check this computer": is this runner's token accepted? Changes nothing (docs/features/runner-check.md).
    { method: "POST", kind: "check", re: /^\/api\/agent\/check$/ },
];

export interface AgentRoute {
    kind: "hello" | "poll" | "heartbeat" | "download" | "upload" | "result" | "recording" | "device" | "update" | "update-file" | "check";
    taskId?: string;
    name?: string;
}

/**
 * Which of the six agent routes a request is, or undefined. `decodedPath` is the path after percent-decoding and without the query,
 * exactly what the router will act on. The match is anchored and exact: method and pattern, no prefix, no case folding, no trailing
 * slash, so every path trick falls through to the API-key check.
 */
export function agentRouteOf(method: string, decodedPath: string): AgentRoute | undefined {
    for (const r of ROUTES) {
        if (r.method !== method) continue;
        const m = r.re.exec(decodedPath);
        if (m) return { kind: r.kind, ...(m[1] ? { taskId: m[1] } : {}), ...(m[2] ? { name: m[2] } : {}) };
    }
    return undefined;
}

/** The ONLY requests that may skip the API key (their credential is the agent token instead). */
export const isAgentRoute = (method: string, decodedPath: string): boolean => agentRouteOf(method, decodedPath) !== undefined;

const BEARER = new RegExp(`^Bearer (${AGENT_TOKEN_PREFIX}[A-Za-z0-9_-]{16,128})$`);

/** The token of an `Authorization: Bearer aitg_…` header, or undefined. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
    if (typeof header !== "string") return undefined;
    return BEARER.exec(header)?.[1];
}

// ── what an agent must have ─────────────────────────────────────────────────

const countOf = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * Can this machine run phone tests, and what to call its Android setup. ONE rule: adb is installed and either a phone is ready
 * (state "device") or an emulator can be started. Routing, the "where tests run" setting and the agent card all use it, so the card
 * can never say "no devices connected" while the setting says phone tests can run.
 */
export function androidSummary(a: Capabilities["android"]): { state: "no-tools" | "phone" | "emulator" | "none"; canRun: boolean; summary: string } {
    if (!a?.adb) return { state: "no-tools", canRun: false, summary: "Android: adb not found" };
    const devices = a.devices;
    const emulators = devices.filter((d) => d.emulator).length;
    const found = `${countOf(devices.length, "device")}${emulators ? `, ${countOf(emulators, "emulator")}` : ""}`;
    if (devices.some((d) => d.state === "device")) return { state: "phone", canRun: true, summary: `Android: ${found}` };
    if (a.avds.length) return { state: "emulator", canRun: true, summary: `Android: ${devices.length ? "no phone ready" : "no phone connected"}, ${countOf(a.avds.length, "emulator")} can be started` };
    if (devices.length) return { state: "none", canRun: false, summary: `Android: ${found}, none ready` };
    return { state: "none", canRun: false, summary: "Android: no devices connected" };
}

/**
 * Why this machine cannot run an adapter's scripts, in plain words, or undefined when it can. Web and API scripts both run in
 * Playwright, so both need an installed browser (the protocol says an empty list means web and API tests cannot run).
 */
export function capabilityProblem(adapter: { id: string; label?: string; runtime: string; needs: RunnerNeeds }, caps: Capabilities): string | undefined {
    const needs = adapter.needs;
    if (adapter.runtime === "playwright" || needs.browsers?.length) {
        if (caps.browsers.length === 0) return caps.browserNote ? `it has no browser ready (${caps.browserNote.replace(/\.$/, "")})` : "it has no browsers installed (run `npx playwright install` on that machine)";
        const missing = (needs.browsers ?? []).filter((b) => !caps.browsers.includes(b));
        if (missing.length) return missing.includes("chromium") && caps.browserNote ? `it has no browser ready (${caps.browserNote.replace(/\.$/, "")})` : `it has no ${missing.join(" or ")} browser installed`;
    }
    if (needs.android) {
        const android = androidSummary(caps.android);
        if (android.state === "no-tools") return "it has no Android tools (adb) installed";
        if (!android.canRun) return "it has no Android phone connected and no emulator set up";
    }
    // A Mac with Xcode, an iOS simulator and the Appium XCUITest driver (one rule, shared with the agent itself).
    if (needs.ios) {
        const why = iosCapabilityProblem(caps);
        if (why) return why;
    }
    if (needs.windows) {
        const w = caps.windows;
        if (caps.os !== "win32") return "it is not a Windows computer";
        if (!w?.uiautomation) return "Windows UI Automation is not available on it";
        if (w.elevated) return "the agent runs as administrator, and desktop tests do not run elevated (restart it as a normal user)";
        if (w.interactive === false) return "it has no interactive desktop session (start the agent from a signed-in Windows session, not a service)";
    }
    return undefined;
}

// ── the run environment on the wire ─────────────────────────────────────────

/** RunEnv → the wire form. A remote run is cleaned up by the agent, because the application may only be reachable from its network. */
export function toWireEnv(env: RunEnv): WireRunEnv {
    const w: WireRunEnv = { baseUrl: env.baseUrl, headless: env.headless };
    if (env.apiBaseUrl !== undefined) w.apiBaseUrl = env.apiBaseUrl;
    if (env.credentials) w.credentials = { username: env.credentials.username, password: env.credentials.password, ...(env.credentials.totpSecret ? { totpSecret: env.credentials.totpSecret } : {}) };
    if (env.roles) w.roles = env.roles.map((r) => ({ name: r.name, username: r.username, password: r.password, ...(r.totpSecret ? { totpSecret: r.totpSecret } : {}), ...(r.apiToken ? { apiToken: r.apiToken } : {}) }));
    if (env.apiToken !== undefined) w.apiToken = env.apiToken;
    if (env.apiAuthHeader !== undefined) w.apiAuthHeader = env.apiAuthHeader;
    if (env.vars) w.vars = { ...env.vars };
    if (env.cleanup) w.cleanup = env.cleanup === "platform" ? "agent" : env.cleanup;
    if (env.storageState !== undefined) w.storageState = env.storageState;
    return WireRunEnv.parse(w);
}

// ── paths ───────────────────────────────────────────────────────────────────

/** A path inside `base` for a file name that came from outside; throws on anything that is not a plain safe name. */
export function anchoredPath(base: string, name: string): string {
    if (!SafeName.safeParse(name).success) throw new Error("unsafe file name");
    const root = path.resolve(base);
    const full = path.resolve(root, name);
    if (path.dirname(full) !== root) throw new Error("unsafe file name");
    return full;
}

// ── secrets ─────────────────────────────────────────────────────────────────

/** Replace every secret of the run, wherever it appears in text, with a marker. Works on any JSON-like value; strings shorter than 4 characters are not secrets. */
export function scrubSecrets<T>(value: T, secrets: string[]): T {
    const list = [...new Set(secrets.filter((s) => s.length >= 4))].sort((a, b) => b.length - a.length);
    if (list.length === 0) return value;
    const walk = (v: unknown): unknown => {
        if (typeof v === "string") {
            let out = v;
            for (const s of list) if (out.includes(s)) out = out.split(s).join("[hidden]");
            return out;
        }
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
        return v;
    };
    return walk(value) as T;
}

/** Every secret string of a run's environment: passwords, authenticator secrets and tokens (user names and variables are not secrets). */
export function envSecrets(env: Pick<RunEnv, "credentials" | "roles" | "apiToken" | "apiAuthHeader">): string[] {
    const list: Array<string | undefined> = [env.credentials?.password, env.credentials?.totpSecret, env.apiToken, env.apiAuthHeader];
    for (const r of env.roles ?? []) list.push(r.password, r.totpSecret, r.apiToken);
    // An auth header "Name: value" is secret as a whole and by its value.
    const h = env.apiAuthHeader;
    if (h && h.includes(":")) list.push(h.slice(h.indexOf(":") + 1).trim());
    return list.filter((s): s is string => typeof s === "string" && s.length >= 4);
}

// ── rate limiting ───────────────────────────────────────────────────────────

/** A sliding window per key, in memory (agent traffic is handled by one API process). */
export class RateLimiter {
    /** Least recently used key first (a key is moved to the end whenever it is used). */
    private readonly hits = new Map<string, number[]>();
    private lastSweep = 0;
    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly clock: () => number = Date.now,
        /** The most keys remembered at once; beyond it the least recently used go first, so the map cannot grow without end however many callers there are. */
        private readonly maxKeys: number = 4096,
    ) {}

    /** How many keys are remembered right now (for tests). */
    get size(): number {
        return this.hits.size;
    }

    /** true = allowed (and counted). */
    take(key: string): boolean {
        const now = this.clock();
        const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
        const allowed = recent.length < this.limit;
        if (allowed) recent.push(now);
        this.hits.delete(key);
        this.hits.set(key, recent);
        // Keys whose hits have all expired are dropped once per window; the cap below holds even when nothing has expired.
        if (now - this.lastSweep >= this.windowMs) {
            this.lastSweep = now;
            for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
        }
        while (this.hits.size > this.maxKeys) {
            const oldest = this.hits.keys().next().value;
            if (oldest === undefined) break;
            this.hits.delete(oldest);
        }
        return allowed;
    }
}
