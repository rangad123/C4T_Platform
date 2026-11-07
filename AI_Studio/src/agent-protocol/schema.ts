/**
 * The wire contract between the platform and a runner agent (protocol version 1, plus the additive protocol 2 near the end).
 *
 * One file, written once by the lead: the platform side (src/platform/agent-*.ts, routes/agents.ts) and the agent program
 * (src/agent/*) both import it, so they cannot drift apart. Change it only together with PROTOCOL_VERSION.
 *
 * Transport: HTTPS, JSON bodies except file transfer (raw bytes). The agent always connects OUT to the platform; the
 * platform never connects to the agent. Every /api/agent/* request carries `Authorization: Bearer aitg_<token>`.
 *
 *   POST /api/agent/hello                    HelloRequest      -> HelloResponse
 *   POST /api/agent/poll                     PollRequest       -> 200 TaskOffer | 204 (nothing after the long-poll wait)
 *   POST /api/agent/tasks/:id/heartbeat      HeartbeatRequest  -> HeartbeatResponse
 *   GET  /api/agent/tasks/:id/files/:ref     (raw bytes)  baselines and the APK the task refers to
 *   PUT  /api/agent/tasks/:id/files/:name    (raw bytes)  an artifact the agent produced -> UploadResponse
 *   POST /api/agent/tasks/:id/result         ResultRequest     -> { ok: true }
 *   POST /api/agent/tasks/:id/recording      RecordingPush     -> { ok: true }   (record tasks only, see "recording on an agent" below)
 *   POST /api/agent/tasks/:id/device         DevicePush        -> { ok: true }   (device tasks only, see "a phone session on an agent" below)
 *   POST /api/agent/tasks/:id/accept|reject|events                              (protocol 2 only, see "protocol 2" below)
 *
 * Secrets: a TaskOffer carries the credentials the run needs (the same RunEnv the platform would give its own runner).
 * It is sent only over the agent's authenticated connection, never logged by either side, and never written to disk by
 * the agent outside the child process environment.
 */
import { z } from "zod";

/**
 * The newest protocol this code speaks. Protocol 2 is additive (attempt ids, accept/reject, live events, durable results; see "protocol 2"
 * below): a platform speaking 2 still serves an agent that speaks only 1 exactly as before, and an agent speaking 2 falls back to 1 when the
 * platform answers 1.
 */
export const PROTOCOL_VERSION = 2;
/** Every protocol version this code can speak, oldest first. */
export const SUPPORTED_PROTOCOLS: readonly number[] = [1, 2];
export const AGENT_TOKEN_PREFIX = "aitg_";

/** A file name that is safe on every operating system and cannot climb out of a directory. */
export const SafeName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/, "unsafe file name");

const Line = z.string().max(300);

// ── capabilities (what the machine can run) ─────────────────────────────────

export const AndroidDevice = z.object({
    serial: z.string().max(80),
    model: z.string().max(80).optional(),
    /** adb state: "device" is ready; "offline" / "unauthorized" are not. */
    state: z.string().max(30),
    /** true for an emulator, false for a USB or Wi-Fi phone. */
    emulator: z.boolean(),
});

/**
 * The Chromium-family browser web tests used or will use on a runner (additive, optional; see docs/features/runner-browsers.md): Playwright's own
 * Chromium ("bundled" when it was already on the computer, "downloaded" when the runner fetched it) or the computer's Google Chrome or Microsoft Edge
 * ("installed"). Never a path.
 */
export const WebBrowserUsed = z.object({
    name: z.enum(["chromium", "chrome", "msedge"]),
    version: z.string().max(40).optional(),
    source: z.enum(["installed", "downloaded", "bundled"]),
});
export type WebBrowserUsed = z.infer<typeof WebBrowserUsed>;

export const Capabilities = z.object({
    os: z.enum(["win32", "darwin", "linux"]),
    arch: z.string().max(20),
    node: z.string().max(40),
    /** Installed Playwright browsers. Empty means web and API tests cannot run here. */
    browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).max(3),
    android: z.object({ adb: z.boolean(), devices: z.array(AndroidDevice).max(40), avds: z.array(z.string().max(64)).max(40) }).optional(),
    /**
     * Recording on this agent (additive, optional). `record`: the agent can host a recording session (it has Chromium). `recordHeaded`: it also has a display
     * (a person can click in the window). The platform offers a record task only to an agent that reports `record: true`; an older agent never sees one.
     */
    record: z.boolean().optional(),
    recordHeaded: z.boolean().optional(),
    /**
     * Driving a recording step by step (additive, optional): the agent understands the `act` and `snapshot` record commands and answers them in a push's `results`.
     * The platform sends those commands only to an agent that reports this; for any other it says plainly that the agent is too old.
     */
    liveSession: z.boolean().optional(),
    /**
     * Custom (hand-written) scripts (additive, optional). true only when the agent was started with --allow-custom-scripts: its owner agrees to run code
     * a person wrote. The platform never offers a script marked `custom` to an agent that does not report this.
     */
    customScripts: z.boolean().optional(),
    /**
     * AI phone exploration (additive, optional): the agent has adb and a phone or an emulator it can use, and understands the `device` task. The platform offers a
     * device task only to an agent that reports this; an older agent never sees one.
     */
    deviceSession: z.boolean().optional(),
    /**
     * The runner's own Android phone tools (additive, optional; see docs/features/phone-setup-simple.md): "can-fetch" means this computer has no adb
     * yet and the runner gets Google's platform-tools itself when a phone session arrives; "ready" means it uses the ones it fetched. Reported only
     * when the runner's setting allows it and no other adb is found. Never a path.
     */
    phoneTools: z
        .object({
            state: z.enum(["ready", "can-fetch", "fetching", "failed", "off", "unsupported"]),
            version: z.string().max(40).optional(),
            note: z.string().max(300).optional(),
        })
        .optional(),
    /**
     * The version of the runner kit this agent was started from (additive, optional): the platform version and the bundle's content hash, as written into
     * the kit's runner.json. Absent for an agent started from a repository checkout. Informational only; the platform never decides anything by it.
     */
    kitVersion: z.string().max(80).optional(),
    /**
     * Browsers on the runner (additive, optional). `browser`: what web tests use here, once it is ready. `installedBrowsers`: the stable Google Chrome and
     * Microsoft Edge found on the computer, with their version and, when one is not used, why (too old, version unreadable). `browserNote`: one plain
     * sentence while no browser is ready (downloading, or the setting asks for a browser the computer does not have). An older agent reports none of them.
     */
    browser: WebBrowserUsed.optional(),
    installedBrowsers: z.array(z.object({ name: z.enum(["chrome", "msedge"]), version: z.string().max(40).optional(), usable: z.boolean(), reason: z.string().max(200).optional() })).max(4).optional(),
    browserNote: z.string().max(300).optional(),
    /**
     * The runner's network (additive, optional; see docs/features/company-networks.md). `proxy`: the proxy its own connections use, as host:port only
     * (never a user name or password; anything else is refused). `proxySource`: where that setting came from. `proxyTests`: tests go through it too.
     * `certificates`: what it trusts besides Node's own list. `problem` / `problemAt`: its last network problem, a plain sentence at most an hour old.
     * Informational only; the platform decides nothing by it. An older runner reports none of it.
     */
    network: z
        .object({
            proxy: z.string().max(260).regex(/^[A-Za-z0-9.\-[\]:]+$/).optional(),
            proxySource: z.enum(["flag", "env", "file", "windows"]).optional(),
            proxyTests: z.boolean().optional(),
            certificates: z.array(z.enum(["system", "file", "extra"])).max(3).optional(),
            problem: z.string().max(400).optional(),
            problemAt: z.string().max(40).optional(),
        })
        .optional(),
    /**
     * The runner keeps itself up to date (additive, optional; docs/features/runner-updates.md). Present only on a runner started from a download
     * that can replace its own files. The platform offers an update (HelloResponse.update, POST /api/agent/update) only to a runner reporting
     * `can: true`; an older runner never sees one.
     */
    update: z.lazy(() => RunnerUpdateState).optional(),
    /**
     * "Check this computer" (additive, optional; docs/features/runner-check.md): what the runner found when it started, one plain line per item
     * (Node.js, its files, the test tools, the browser, the network, free disk space, the clock, phone tools, on a Mac the chip and the quarantine
     * flag), each ok, missing or optional, with how to fix it. Never a token, a password or a path. Informational only; an older runner reports none.
     */
    check: z.lazy(() => RunnerCheck).optional(),
    /**
     * Reported on a Mac when Xcode is found. `simulators` are labels such as "iPhone 15 (Booted)" (every platform simctl lists). iOS tests (adapter
     * `taqwright-ios`) need an agent that also reports `xcuitest: true` (the Appium XCUITest driver is installed) and at least one iOS simulator
     * (`iosSimulators`, additive and optional). An agent that does not report them is never offered an iOS task.
     */
    ios: z.object({ xcode: z.boolean(), simulators: z.array(z.string().max(80)).max(40), xcuitest: z.boolean().optional(), iosSimulators: z.number().int().min(0).max(1000).optional() }).optional(),
    /**
     * Windows desktop tests. `uiautomation`: powershell.exe exists and the UI Automation assemblies load (the adapter `windows-uia` needs it).
     * `interactive`: the agent runs in a signed-in user session, not as a service (false = desktop tests cannot work). `elevated`: the agent runs
     * as administrator (desktop tests refuse to run elevated). `allowedApps`: the full paths this agent was told it may start (--allow-app);
     * the platform uses it to refuse a run early, the agent still decides. `winappdriver` is only reported when found and is not used.
     */
    windows: z
        .object({
            winappdriver: z.boolean().optional(),
            uiautomation: z.boolean().optional(),
            interactive: z.boolean().optional(),
            elevated: z.boolean().optional(),
            allowedApps: z.array(z.string().max(300)).max(60).optional(),
        })
        .optional(),
    /**
     * Who the machine is (additive, optional; an older runner reports none of them). `osVersion`: the operating system's own version, e.g.
     * "10.0.22631" or "14.5". `memoryMb` and `cpus`: total memory and logical processors. `playwrightVersion`: the test tool's version.
     * `adapters`: the test frameworks this runner program can run (whether this computer has what each needs is the rest of the capabilities).
     * Informational, except that a missing value is never read as "can".
     */
    osVersion: z.string().max(60).optional(),
    memoryMb: z.number().int().min(0).max(16_777_216).optional(),
    cpus: z.number().int().min(0).max(4096).optional(),
    playwrightVersion: z.string().max(40).optional(),
    adapters: z.array(z.string().max(40)).max(40).optional(),
    /**
     * The runner applies the platform's switches for it (additive, optional): code scripts and private addresses, as told in the hello answer's
     * `runner` and in heartbeats. The platform turns a switch into offers only for a runner reporting this; an older runner keeps today's rules.
     */
    runnerSwitches: z.boolean().optional(),
});
export type Capabilities = z.infer<typeof Capabilities>;

/** One line of the runner's "Check this computer" (docs/features/runner-check.md): `title` says what was found, `fix` what to do when it is not ok. */
export const RunnerCheckItem = z.object({
    id: z.string().regex(/^[a-z][a-z-]{0,23}$/),
    status: z.enum(["ok", "missing", "optional"]),
    title: z.string().max(300),
    fix: z.string().max(400).optional(),
});
export const RunnerCheck = z.object({
    /** When the runner made the check (ISO time). */
    at: z.string().max(40),
    items: z.array(RunnerCheckItem).max(20),
});
export type RunnerCheck = z.infer<typeof RunnerCheck>;
export type RunnerCheckItem = z.infer<typeof RunnerCheckItem>;

// ── hello ───────────────────────────────────────────────────────────────────

export const HelloRequest = z.object({
    /** The oldest protocol the agent speaks (1 for every agent so far, so a protocol-1 platform accepts it). */
    protocol: z.number().int(),
    /** Protocol 2: every version the agent speaks (additive, optional). The platform answers the highest one both sides speak in `protocol`. */
    protocols: z.array(z.number().int().min(1).max(99)).max(8).optional(),
    name: z.string().trim().min(1).max(64),
    /** The agent program's own version (informational). */
    version: z.string().max(40),
    capabilities: Capabilities,
    /** How many tasks the agent can run at once (1-8). */
    concurrency: z.number().int().min(1).max(8),
    /**
     * This installation's random id, made once and kept next to its settings (additive, optional). The platform binds a credential to the
     * first one it sees and refuses that credential from another computer. An older agent sends none and keeps today's behaviour.
     */
    machineId: z.lazy(() => MachineId).optional(),
});
export type HelloRequest = z.infer<typeof HelloRequest>;

export const HelloResponse = z.object({
    agentId: z.string(),
    projectId: z.string(),
    /** The protocol version both sides speak from now on (protocol 2: the highest of the agent's `protocols` the platform speaks); the agent stops with a plain message when it cannot speak it. */
    protocol: z.number().int(),
    pollSeconds: z.number().int(),
    heartbeatSeconds: z.number().int(),
    maxFileBytes: z.number().int(),
    serverTime: z.string(),
    /** The platform's runner files, when this runner should update itself (additive, optional; only for a runner reporting `update.can`). */
    update: z.lazy(() => RunnerUpdateOffer).optional(),
    /**
     * What this runner is and what its switches allow (additive, optional). `customScripts`: the platform's switch for code scripts on it
     * (a personal runner follows it alone; a team runner also takes them when started with --allow-custom-scripts). `privateTargets`: runs
     * against localhost, LAN and link-local addresses may go to it (false: the runner blocks them in every test it runs, too).
     */
    runner: z.object({ id: z.string().max(64), kind: z.enum(["team", "personal"]), customScripts: z.boolean(), privateTargets: z.boolean() }).optional(),
    /** The credential is due for a new one: a runner that keeps its credential in the computer's store asks POST /api/agent/rotate. */
    rotate: z.boolean().optional(),
});
export type HelloResponse = z.infer<typeof HelloResponse>;

// ── enrollment and credentials (additive; docs/features/runner-enrollment.md) ──
//
//   POST /api/agent/enroll   EnrollRequest  -> EnrollResponse   no Authorization header: the single-use code is the credential, once
//   POST /api/agent/rotate   {}             -> RotateResponse   with the current credential; the old one works until the new one is used (24 h at most)
//
// A download carries an enrollment code (runner.enroll), never a runner credential. The agent trades it at its first contact, keeps the
// credential in the computer's own store (credential-store.ts) and deletes the code file. A used, expired or unknown code is a 410 or 404
// with a sentence that says to make a new one on the Runners page.

export const ENROLLMENT_CODE_PREFIX = "aite_";
export const EnrollmentCode = z.string().regex(/^aite_[A-Za-z0-9_-]{20,200}$/, "not an enrollment code");
export const MachineId = z.string().regex(/^[A-Za-z0-9-]{16,64}$/, "not an install id");
export const EnrollRequest = z.object({
    code: EnrollmentCode,
    name: z.string().trim().min(1).max(64),
    machineId: MachineId,
    version: z.string().max(40).optional(),
    capabilities: Capabilities.optional(),
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;
export const EnrollResponse = z.object({ token: z.string().regex(/^aitg_[A-Za-z0-9_-]{20,200}$/), runnerId: z.string().max(64), kind: z.enum(["team", "personal"]) });
export type EnrollResponse = z.infer<typeof EnrollResponse>;
export const RotateResponse = z.object({ token: z.string().regex(/^aitg_[A-Za-z0-9_-]{20,200}$/), previousValidUntil: z.string().max(40) });
export type RotateResponse = z.infer<typeof RotateResponse>;

// ── runner updates (additive, optional; docs/features/runner-updates.md) ─────
//
//   POST /api/agent/update                 { agentId }   -> { update?: RunnerUpdateOffer }   what to update to, when the platform wants it
//   GET  /api/agent/update/files/:name     (raw bytes)  one file of that offer, with x-content-sha256
//
// A poll answer (200 or 204) carries the header `x-runner-update: <auto|requested> <version>` while the platform wants the runner on its
// version, so an idle runner learns it without a new hello. Every byte of an update is checked against the sha256 in the offer, which only
// ever comes over the runner's authenticated connection.

export const RUNNER_UPDATE_HEADER = "x-runner-update";
/** The exit code with which a runner asks its start script or launcher to start it again at once (after switching to a new version). */
export const RUNNER_UPDATE_EXIT = 75;

const Sha = z.string().regex(/^[0-9a-f]{64}$/);

/** What a runner says about its updates. `state`: idle, preparing (downloading and checking), ready (waiting for its tasks to finish), updated, failed, rolled-back. */
export const RunnerUpdateState = z.object({
    can: z.boolean(),
    /** needs-manual: an update was offered but its signature did not check, so it was not installed; a person downloads it (round 39). */
    state: z.enum(["idle", "preparing", "ready", "updated", "failed", "rolled-back", "needs-manual"]),
    /** The version it updated from / tried to update to. */
    from: z.string().max(80).optional(),
    to: z.string().max(80).optional(),
    /** One plain sentence: why the last update did not happen. */
    error: z.string().max(400).optional(),
    at: z.string().max(40).optional(),
    /** It will not try again before this time (back-off after failures, at most 3 attempts an hour). */
    retryAt: z.string().max(40).optional(),
    /** The sha256 of its package.json (the test tool versions), its node_modules came with a complete download, it runs the Node.js inside its folder. */
    packageSha256: Sha.optional(),
    complete: z.boolean().optional(),
    bundledNode: z.boolean().optional(),
});
export type RunnerUpdateState = z.infer<typeof RunnerUpdateState>;

export const UpdateFile = z.object({ name: SafeName, size: z.number().int().min(0).max(400 * 1024 * 1024), sha256: Sha });
export type UpdateFile = z.infer<typeof UpdateFile>;

/** One folder of a complete download (node_modules, or the Node.js runtime): a list file (path, mode, sizes, sha256 per file) and a pack of the compressed files in that order. */
export const UpdatePart = z.object({ folder: z.enum(["node_modules", "node"]), list: UpdateFile, pack: z.object({ name: SafeName, size: z.number().int().min(0).max(400 * 1024 * 1024) }) });
export type UpdatePart = z.infer<typeof UpdatePart>;

export const RunnerUpdateOffer = z.object({
    /** The platform's runner version (the kit version: platform version plus the bundle's hash). */
    version: z.string().min(1).max(80),
    /** auto: the runner updates by itself; requested: a person pressed "Update this runner". */
    reason: z.enum(["auto", "requested"]),
    /** The runner programs and package.json, exactly the bundle a new download would hold. */
    files: z.array(UpdateFile).min(1).max(20),
    /** For a runner from a complete download: the parts that changed (new test tools, a new pinned Node.js). */
    complete: z.object({ target: z.string().max(20), nodeVersion: z.string().max(40), parts: z.array(UpdatePart).max(2) }).optional(),
    /** The deploy's signed update manifest and its signature, exactly as written (src/agent-protocol/update-manifest.ts). Older runners ignore it. */
    signed: z.object({ manifest: z.string().min(2).max(65536), signature: z.string().min(2).max(1024) }).optional(),
});
export type RunnerUpdateOffer = z.infer<typeof RunnerUpdateOffer>;

/** One entry of a part's list file. `path` is relative to the part's folder. */
export const UpdatePartList = z.object({
    format: z.literal(1),
    folder: z.enum(["node_modules", "node"]),
    files: z
        .array(
            z.object({
                path: z.string().min(1).max(400).regex(/^[\x21-\x7e ]+$/).refine((p) => !p.startsWith("/") && !p.includes("\\") && !p.split("/").some((s) => s === "" || s === "." || s === ".."), "not a plain relative path"),
                mode: z.number().int().min(0).max(0o777),
                size: z.number().int().min(0).max(300 * 1024 * 1024),
                csize: z.number().int().min(0).max(300 * 1024 * 1024),
                sha256: Sha,
            }),
        )
        .max(60_000),
});
export type UpdatePartList = z.infer<typeof UpdatePartList>;

// ── poll and the task ───────────────────────────────────────────────────────

export const PollRequest = z.object({
    agentId: z.string(),
    /** Fresh capabilities, so a phone plugged in after start-up is noticed. Optional. */
    capabilities: Capabilities.optional(),
    /** Free task slots right now; the platform offers a task only when this is at least 1. */
    freeSlots: z.number().int().min(0).max(8),
});
export type PollRequest = z.infer<typeof PollRequest>;

export const FileRef = z.object({ ref: SafeName, size: z.number().int().min(0), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export type FileRef = z.infer<typeof FileRef>;

/** Same shape as RunEnv in src/engine/validation/runner.ts (kept in sync by a test). */
export const WireRunEnv = z.object({
    baseUrl: z.string(),
    apiBaseUrl: z.string().optional(),
    credentials: z.object({ username: z.string(), password: z.string(), totpSecret: z.string().optional() }).optional(),
    roles: z.array(z.object({ name: z.string(), username: z.string(), password: z.string(), totpSecret: z.string().optional(), apiToken: z.string().optional() })).optional(),
    apiToken: z.string().optional(),
    apiAuthHeader: z.string().optional(),
    vars: z.record(z.string()).optional(),
    /** "agent": the agent cleans up the records the run created (the application may only be reachable from its network). */
    cleanup: z.enum(["platform", "off", "agent"]).optional(),
    headless: z.boolean(),
    /** The project's saved sign-in (a Playwright storage state, JSON text): scripts marked `session` start signed in with it. A secret, like the credentials. */
    storageState: z.string().max(1_000_000).optional(),
});
export type WireRunEnv = z.infer<typeof WireRunEnv>;

export const WireScript = z.object({
    testId: z.string(),
    filename: SafeName,
    content: z.string(),
    /** Approved visual baselines the script compares against, fetched with GET /files/:ref. */
    baselines: z.array(z.object({ name: SafeName, file: FileRef })).optional(),
    /** true for a hand-written script (a test the person took over, imported from Git or wrote). The agent refuses it unless it was started with --allow-custom-scripts. */
    custom: z.boolean().optional(),
    /** Start this script signed in with the environment's `storageState` (the project's saved sign-in). */
    session: z.boolean().optional(),
});
export type WireScript = z.infer<typeof WireScript>;

export const WireMobile = z.object({
    appPackage: z.string().optional(),
    avd: z.string().optional(),
    /** The APK to install (cached by the agent per sha256). */
    apk: FileRef.optional(),
    /** A specific adb serial to use instead of an emulator. */
    deviceSerial: z.string().max(80).optional(),
    keepEmulator: z.boolean().optional(),
    /**
     * Added in round 24 (optional, version stays 1): the project's "Where phone tests run" and the device its last exploration used, so the runner
     * makes the same device choice the platform would (engine/mobile/device/choose.ts). An older runner ignores them and starts its emulator.
     */
    runsOn: z.object({ kind: z.enum(["auto", "explored", "phone", "emulator", "farm"]), serial: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/).optional(), model: z.string().max(60).optional() }).optional(),
    exploredOn: z.object({ serial: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/), model: z.string().max(60).optional(), emulator: z.boolean() }).optional(),
});

/** iOS tests (adapter `taqwright-ios`; additive and optional): the app already installed on the simulator and which simulator to use. */
export const WireIos = z.object({
    bundleId: z.string().max(200).optional(),
    /** The simulator the app names; wins over `defaultSimulator`. */
    simulator: z.string().max(64).optional(),
    /** The project's default simulator (framework settings). */
    defaultSimulator: z.string().max(64).optional(),
    keepSimulator: z.boolean().optional(),
});

// ── recording on an agent (additive; protocol stays 1) ──────────────────────
//
// A record task asks the agent to open its own browser on its own machine (so the person clicks through the application where it is reachable and where they
// can see the window), record the steps, and keep the platform up to date. The agent pushes the whole recording state (RecordingPush) on every change, at most
// about once a second, and the platform answers commands from the web page (inspect, patch, delete, stop, discard) in the heartbeat reply. The agent applies a
// command, then pushes the new state with the command's id in `acked`. When the session ends the agent posts a normal result with ok=true and no runs.
// The shapes mirror RECORDER-API-SHAPES.md and src/engine/recorder/model.ts (a unit test keeps them in sync).

export const RecLocatorWire = z.object({
    strategy: z.enum(["testId", "role", "label", "placeholder", "text", "css"]),
    value: z.string().max(300),
    name: z.string().max(300).optional(),
    exact: z.boolean().optional(),
});
export type RecLocatorWire = z.infer<typeof RecLocatorWire>;

const RecAlternativeWire = z.object({ locator: RecLocatorWire, matches: z.number().int().min(0) });
const RecAssertWire = z.object({
    check: z.enum(["visible", "hidden", "text", "value", "enabled", "disabled", "count"]),
    expected: z.union([z.string().max(300), z.number()]).optional(),
});

export const RecStepWire = z.object({
    index: z.number().int().min(0),
    kind: z.enum(["goto", "click", "fill", "select", "check", "uncheck", "press", "assert", "upload", "drag"]),
    url: z.string().max(2000).optional(),
    locator: RecLocatorWire.optional(),
    /** Additive (frames, uploads, drag and drop, popups): where a dragged element was dropped, the frames the element is in, and the popup window. */
    target: RecLocatorWire.optional(),
    frame: z.array(z.object({ by: z.enum(["name", "title", "url"]), value: z.string().max(300) })).max(3).optional(),
    inPopup: z.boolean().optional(),
    opensPopup: z.boolean().optional(),
    alternatives: z.array(RecAlternativeWire).max(6).optional(),
    matches: z.number().int().min(0).optional(),
    value: z.string().max(1000).optional(),
    /** true when `value` is a placeholder standing in for a secret (a password is never sent to the platform). */
    secret: z.boolean().optional(),
    assert: RecAssertWire.optional(),
    ref: z.string().max(120).optional(),
    describe: z.string().max(400),
    at: z.string(),
});
export type RecStepWire = z.infer<typeof RecStepWire>;

// ── driving a recording step by step (additive; protocol stays 1) ───────────
//
// `act` performs one action in the recording's page and `snapshot` reads the page; both travel as record commands and are answered in a push's `results`
// (the same id). Only an agent that reports `capabilities.liveSession` is sent them. The shapes mirror src/engine/recorder/act.ts (a unit test keeps them in sync).

export const LIVE_ACTIONS = ["navigate", "click", "fill", "press", "select", "check", "waitForText", "scroll"] as const;
export const LiveActionWire = z.discriminatedUnion("action", [
    z.object({ action: z.literal("navigate"), url: z.string().min(1).max(2000) }),
    z.object({ action: z.literal("click"), locator: RecLocatorWire }),
    z.object({ action: z.literal("fill"), locator: RecLocatorWire, value: z.string().max(500) }),
    z.object({ action: z.literal("press"), locator: RecLocatorWire.optional(), value: z.enum(["Enter", "Escape", "Tab"]) }),
    z.object({ action: z.literal("select"), locator: RecLocatorWire, value: z.string().max(500) }),
    z.object({ action: z.literal("check"), locator: RecLocatorWire, checked: z.boolean().optional() }),
    z.object({ action: z.literal("waitForText"), value: z.string().min(1).max(200), timeoutMs: z.number().int().min(100).max(15_000).optional() }),
    z.object({ action: z.literal("scroll"), value: z.enum(["down", "up", "top", "bottom"]).optional() }),
]);
export type LiveActionWire = z.infer<typeof LiveActionWire>;

export const LiveElementWire = z.object({
    index: z.number().int().min(0),
    tag: z.string().max(30),
    role: z.string().max(40).optional(),
    name: z.string().max(200).optional(),
    /** The best locator (the inspector's ranking) and how many elements it finds on the page. */
    locator: RecLocatorWire,
    matches: z.number().int().min(0),
    visible: z.boolean(),
    enabled: z.boolean(),
    /** Never set for a password, one-time-code or card field: those say "[hidden]". */
    value: z.string().max(300).optional(),
    checked: z.boolean().optional(),
    secret: z.boolean().optional(),
});
export type LiveElementWire = z.infer<typeof LiveElementWire>;

/** Largest picture kept in a snapshot, in bytes before base64. */
export const LIVE_IMAGE_MAX_BYTES = 400_000;
export const LiveSnapshotWire = z.object({
    url: z.string().max(2000),
    title: z.string().max(300),
    text: z.string().max(8000),
    elements: z.array(LiveElementWire).max(80),
    /** true when the text or the element list was cut to fit. */
    truncated: z.boolean().optional(),
    /** Base64 of a small picture of the page (only when asked for). */
    image: z.string().max(Math.ceil((LIVE_IMAGE_MAX_BYTES * 4) / 3) + 8).optional(),
    imageType: z.enum(["image/png", "image/jpeg"]).optional(),
});
export type LiveSnapshotWire = z.infer<typeof LiveSnapshotWire>;

/** The id of a command the platform sent (the platform makes short ones like "c12"); the agent only repeats it, so it is capped. */
const CommandId = z.string().min(1).max(40);

/** The agent's answer to an `act` or `snapshot` command. */
export const LiveResultWire = z.object({
    id: CommandId,
    ok: z.boolean(),
    /** HTTP-like status of a refusal (409 busy, 400 bad action, 422 not allowed...). */
    status: z.number().int().min(100).max(599).optional(),
    error: z.string().max(400).optional(),
    /** An act: whether it became a recorded step (a scroll or a wait does not). */
    recorded: z.boolean().optional(),
    step: RecStepWire.optional(),
    note: z.string().max(300).optional(),
    snapshot: LiveSnapshotWire.optional(),
});
export type LiveResultWire = z.infer<typeof LiveResultWire>;

export const RecordTask = z.object({
    /** The platform's recording id (the web page and the agent talk about the same session). */
    recordingId: z.string(),
    startUrl: z.string().max(2000),
    /** Show the browser window. */
    headed: z.boolean(),
    /** Limits the platform wants enforced (the agent may apply stricter ones): idle and total minutes, step cap. */
    idleMinutes: z.number().int().min(1).max(120).default(20),
    totalMinutes: z.number().int().min(1).max(480).default(60),
    maxSteps: z.number().int().min(1).max(1000).default(300),
});
export type RecordTask = z.infer<typeof RecordTask>;

/** A command from the web page, delivered in the heartbeat reply. */
export const RecordCommand = z.discriminatedUnion("type", [
    z.object({ id: CommandId, type: z.literal("inspect"), on: z.boolean(), mode: z.enum(["locator", "assertion"]).optional(), check: RecAssertWire.shape.check.optional() }),
    z.object({ id: CommandId, type: z.literal("patch"), index: z.number().int().min(0), locator: RecLocatorWire.optional(), value: z.string().max(1000).optional(), assert: RecAssertWire.optional() }),
    z.object({ id: CommandId, type: z.literal("delete"), index: z.number().int().min(0) }),
    z.object({ id: CommandId, type: z.literal("stop") }),
    z.object({ id: CommandId, type: z.literal("discard") }),
    // Only sent to an agent that reports `capabilities.liveSession`. `secret` is the value of a `{{credentials...}}` placeholder the platform resolved for a fill:
    // it travels only on this authenticated link and is never echoed back.
    // `origins` (additive, optional) are the origins the stand-in may be typed on: the agent checks the page it drives against them right before typing.
    z.object({ id: CommandId, type: z.literal("act"), action: LiveActionWire, secret: z.string().max(600).optional(), origins: z.array(z.string().max(300)).max(5).optional(), image: z.boolean().optional() }),
    z.object({ id: CommandId, type: z.literal("snapshot"), image: z.boolean() }),
]);
export type RecordCommand = z.infer<typeof RecordCommand>;

export const RecordingPush = z.object({
    status: z.enum(["starting", "recording", "stopped", "failed"]),
    currentUrl: z.string().max(2000).optional(),
    steps: z.array(RecStepWire).max(1000),
    inspect: z.object({ on: z.boolean(), mode: z.enum(["locator", "assertion"]), check: RecAssertWire.shape.check.optional() }).optional(),
    picked: z.object({ locator: RecLocatorWire, alternatives: z.array(RecAlternativeWire).max(6), tag: z.string().max(40), text: z.string().max(200).optional(), at: z.string() }).optional(),
    /** Plain-words notes (for example "A file upload was not recorded."). */
    notes: z.array(z.string().max(300)).max(20).optional(),
    error: z.string().max(500).optional(),
    /** Ids of the commands applied since the last push. */
    acked: z.array(CommandId).max(40).optional(),
    /** Answers to `act` and `snapshot` commands (additive, optional). */
    results: z.array(LiveResultWire).max(5).optional(),
});
export type RecordingPush = z.infer<typeof RecordingPush>;

/** Android application ids look like `com.example.app` (the same rule as src/engine/mobile/target.ts). */
const PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

// ── a phone session on an agent (additive; protocol stays 1) ────────────────
//
// A device task asks the agent to open the Android app under test on a phone or emulator of ITS computer and to answer, one at a time, what the explorer on the
// platform asks: read the screen (`snapshot`) or do one thing (`act`). Commands travel in the heartbeat reply (`deviceCommands`), answers come back as pushes
// (`DevicePush.results`, matched by id). The shapes mirror src/engine/mobile/device/types.ts (a unit test keeps them in sync). The agent re-checks every action;
// an action names an element of the last snapshot and carries no coordinates, no package and no command line, so nothing else can be said.

/** Largest number of elements a snapshot lists. */
export const DEVICE_MAX_ELEMENTS = 120;
/** Longest text an action may type. */
export const DEVICE_MAX_TYPED = 200;
/** Longest wait an action may ask for. */
export const DEVICE_MAX_WAIT_MS = 3000;
/** Largest picture in a snapshot, in characters of base64 (about 120 KB of JPEG). */
export const DEVICE_MAX_IMAGE_B64 = 164_000;

const ElementIndex = z
    .number({ invalid_type_error: "The element number must be a whole number." })
    .int("The element number must be a whole number.")
    .min(0, "That element is not on the screen.")
    .max(DEVICE_MAX_ELEMENTS - 1, "That element is not on the screen.");

/** One thing the explorer may do. Strict: any other field (a package, a pair of coordinates, a command) is refused. */
export const DeviceActionWire = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("tap"), index: ElementIndex }).strict(),
    z.object({ kind: z.literal("longPress"), index: ElementIndex }).strict(),
    z.object({ kind: z.literal("type"), index: ElementIndex, text: z.string({ invalid_type_error: "The text to type must be text." }).max(DEVICE_MAX_TYPED, `Text to type can be at most ${DEVICE_MAX_TYPED} characters.`), clear: z.boolean().optional() }).strict(),
    z.object({ kind: z.literal("scroll"), index: ElementIndex.optional(), direction: z.enum(["up", "down", "left", "right"], { errorMap: () => ({ message: "Scroll up, down, left or right." }) }) }).strict(),
    z.object({ kind: z.literal("back") }).strict(),
    z.object({ kind: z.literal("hideKeyboard") }).strict(),
    z.object({ kind: z.literal("launch") }).strict(),
    z.object({ kind: z.literal("restart") }).strict(),
    z.object({ kind: z.literal("wait"), ms: z.number({ invalid_type_error: "Waiting needs a number of milliseconds." }).int("Waiting needs a whole number of milliseconds.").min(0, "Waiting needs a positive time.").max(DEVICE_MAX_WAIT_MS, "Waiting is limited to 3 seconds at a time.") }).strict(),
], { errorMap: () => ({ message: "That is not something the phone can be asked to do." }) });
export type DeviceActionWire = z.infer<typeof DeviceActionWire>;

export const DeviceElementWire = z.object({
    index: z.number().int().min(0).max(DEVICE_MAX_ELEMENTS - 1),
    cls: z.string().max(60),
    text: z.string().max(80),
    desc: z.string().max(80),
    id: z.string().max(120),
    clickable: z.boolean(),
    longClickable: z.boolean(),
    scrollable: z.boolean(),
    editable: z.boolean(),
    password: z.boolean(),
    checkable: z.boolean(),
    checked: z.boolean(),
    enabled: z.boolean(),
    focused: z.boolean(),
    bounds: z.tuple([z.number().int().min(-100_000).max(100_000), z.number().int().min(-100_000).max(100_000), z.number().int().min(-100_000).max(100_000), z.number().int().min(-100_000).max(100_000)]),
    // Added in round 24 (optional, version stays 1): where the element sits, for the locators a written test uses (mobile/explore/locators.ts).
    scopes: z.array(z.string().max(120)).max(6).optional(),
    inScroll: z.literal(true).optional(),
    selected: z.literal(true).optional(),
    bareId: z.literal(true).optional(),
});

export const DeviceSnapshotWire = z.object({
    package: z.string().max(200),
    activity: z.string().max(200).optional(),
    width: z.number().int().min(0).max(30_000),
    height: z.number().int().min(0).max(30_000),
    elements: z.array(DeviceElementWire).max(DEVICE_MAX_ELEMENTS),
    fingerprint: z.string().max(64),
    /** Base64 JPEG, password fields covered on the agent before it leaves the phone's computer. */
    screenshot: z.string().max(DEVICE_MAX_IMAGE_B64).optional(),
    keyboard: z.boolean(),
    outsideApp: z.boolean(),
});
export type DeviceSnapshotWire = z.infer<typeof DeviceSnapshotWire>;

export const DeviceResultWire = z.object({
    id: z.string().min(1).max(40),
    ok: z.boolean(),
    error: z.string().max(400).optional(),
    snapshot: DeviceSnapshotWire.optional(),
});
export type DeviceResultWire = z.infer<typeof DeviceResultWire>;

/** A command from the explorer, delivered in the heartbeat reply (repeated until the agent has answered it; the agent runs each id once). */
export const DeviceCommand = z.discriminatedUnion("type", [
    z.object({ id: z.string().min(1).max(40), type: z.literal("snapshot"), screenshot: z.boolean() }),
    z.object({ id: z.string().min(1).max(40), type: z.literal("act"), action: DeviceActionWire, screenshot: z.boolean().optional() }),
]);
export type DeviceCommand = z.infer<typeof DeviceCommand>;

/** What the platform asks of the agent for a device task. */
export const DeviceTask = z.object({
    /** The platform's session id (the explorer and the agent talk about the same session). */
    sessionId: z.string().min(1).max(64),
    /** The app under test: the only package the session may start or stop. */
    appPackage: z.string().regex(PACKAGE, "must be an Android application id such as com.example.app").max(200),
    /** An APK to install first (cached by the agent per sha256). */
    apk: FileRef.optional(),
    avd: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    deviceSerial: z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/).optional(),
    /** What the session may type for {{credentials.*}}. Encrypted at rest with the rest of the task; typed on the agent's computer, never sent back. */
    credentials: z.object({ username: z.string().max(200).optional(), password: z.string().max(200).optional() }).optional(),
    /** Limits the platform wants enforced (the agent may apply stricter ones). */
    maxActions: z.number().int().min(1).max(500).default(200),
    totalMinutes: z.number().int().min(1).max(120).default(20),
    /** Additive (round 39): the project wants an emulator even when a real phone is connected. */
    emulatorOnly: z.boolean().optional(),
    /**
     * Additive (round 39): false on a person's own computer whose owner did not turn on "Use my connected phone": a plugged-in phone is never
     * used, only an emulator. Sent only to a runner that reports `runnerSwitches` (an older one could ignore it, so it gets no such task).
     */
    realPhone: z.boolean().optional(),
    /** Additive (round 39): on a real phone, remove the app at the end if this session installed it (a person's own computer). */
    removeInstalledApp: z.boolean().optional(),
});
export type DeviceTask = z.infer<typeof DeviceTask>;

/** The agent's state and answers for a device task: `POST /api/agent/tasks/:id/device`. */
export const DevicePush = z.object({
    status: z.enum(["starting", "ready", "ended", "failed"]),
    deviceName: z.string().max(80).optional(),
    /** Plain-words progress ("Starting the emulator"). */
    notes: z.array(z.string().max(300)).max(20).optional(),
    error: z.string().max(500).optional(),
    /** Answers to `snapshot` and `act` commands. */
    results: z.array(DeviceResultWire).max(5).optional(),
});
export type DevicePush = z.infer<typeof DevicePush>;

export const TaskOffer = z.object({
    taskId: z.string(),
    jobId: z.string(),
    /** Which adapter runs the batch: "playwright" (web and API together) or "taqwright". Ids of src/engine/frameworks. */
    adapterId: z.string(),
    /** Seconds the platform waits without a heartbeat before it gives the task up. */
    leaseSeconds: z.number().int(),
    workers: z.number().int().min(1).max(8),
    timeoutMs: z.number().int().optional(),
    /**
     * The project's own time limit per test (project framework settings), in ms. Absent: the framework's usual limit. An older agent that does not know
     * the field ignores it and runs with the usual limit. (A visible browser window travels in `env.headless`, which protocol 1 always had.)
     */
    testTimeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    /** Windows desktop tests only: how long an application may take to show its window, in ms (project framework settings). Absent: 15 s. */
    startTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
    /** Playwright projects for a cross-browser run (same as RunnerProject). */
    projects: z.array(z.object({ name: z.string(), device: z.string(), viewport: z.object({ width: z.number(), height: z.number() }).optional() })).optional(),
    /** Absent or "run": execute the scripts. "record": host a recording session (the agent must have reported `record: true`). */
    kind: z.enum(["run", "record", "device"]).optional(),
    scripts: z.array(WireScript).max(500),
    /** Shared helper modules custom scripts import as ./helpers/<name> (additive, optional; at most 20 of at most 100 KB). The agent writes them next to the scripts. */
    helpers: z.array(z.object({ name: z.string().regex(/^[a-z][a-z0-9-]{0,40}$/), content: z.string().max(100_000) })).max(20).optional(),
    env: WireRunEnv,
    mobile: WireMobile.optional(),
    /** iOS tasks only (additive, optional). */
    ios: WireIos.optional(),
    /** Present when kind is "record". */
    record: RecordTask.optional(),
    /** Present when kind is "device" (AI phone exploration; the agent must have reported `deviceSession: true`). */
    device: DeviceTask.optional(),
    /**
     * Protocol 2 only (absent for a protocol-1 agent): this hand-out of the task. Every claim mints a new id; the agent sends it with each
     * accept, reject, heartbeat, event, upload and result, and a message for an attempt that is no longer the current one is refused with 409.
     */
    attemptId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
    /** Protocol 2 only: 1 for the first hand-out, 2 after a re-offer, ... */
    attempt: z.number().int().min(1).optional(),
    /** Protocol 2 only: seconds the agent has to accept (POST .../accept) before the task goes back to the queue. */
    acceptSeconds: z.number().int().min(1).optional(),
    /**
     * Protocol 2 only: the runner's switches as they are when the task is handed out. A switch changed while the runner sat idle reaches it
     * here (a heartbeat `config` only reaches a runner that is working), so the runner does not turn down a task its owner just allowed.
     */
    config: z.lazy(() => RunnerConfigPush).optional(),
});
export type TaskOffer = z.infer<typeof TaskOffer>;

/**
 * TaskOffer plus the rules that depend on `kind`: a run task has at least one script, a record task has its record settings. Use this to check an
 * offer that arrives over the wire; `TaskOffer` stays a plain object so code that builds or reshapes offers (`.omit`, `.shape`) is unaffected.
 */
export const CheckedTaskOffer = TaskOffer.superRefine((t, ctx) => {
    if (t.kind === "record") {
        if (!t.record) ctx.addIssue({ code: "custom", path: ["record"], message: "a record task needs its record settings" });
    } else if (t.kind === "device") {
        if (!t.device) ctx.addIssue({ code: "custom", path: ["device"], message: "a device task needs its device settings" });
    } else if (t.scripts.length < 1) ctx.addIssue({ code: "too_small", minimum: 1, type: "array", inclusive: true, path: ["scripts"], message: "a run task needs at least one script" });
});

// ── heartbeat ───────────────────────────────────────────────────────────────

/** What the agent says it is doing (protocol 2: heartbeats and `phase` events). */
export const AgentPhase = z.enum(["preparing", "running", "uploading"]);
export type AgentPhase = z.infer<typeof AgentPhase>;

export const HeartbeatRequest = z.object({
    done: z.number().int().min(0).optional(),
    total: z.number().int().min(0).optional(),
    /** Progress lines (emulator start-up and the like), at most 20 per beat. */
    log: z.array(Line).max(20).optional(),
    /** Protocol 2: the attempt this beat is for (see TaskOffer.attemptId). */
    attemptId: z.string().max(64).optional(),
    /** Protocol 2: what the agent is doing now. The platform only ever moves a task forward (preparing, running, uploading). */
    phase: AgentPhase.optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

/** Protocol 2: what the runner's switches say now (only sent when they changed since the task was offered). */
export const RunnerConfigPush = z.object({
    /** The owner allows code scripts (hand-written, imported, Git) on this runner. */
    customScripts: z.boolean().optional(),
    /** The owner allows private and local addresses (localhost, LAN, 169.254.x) on this runner. */
    privateTargets: z.boolean().optional(),
});
export type RunnerConfigPush = z.infer<typeof RunnerConfigPush>;

export const HeartbeatResponse = z.object({
    /** True when the job was cancelled: the agent stops the child process and posts a result with ok=false. */
    cancel: z.boolean(),
    leaseSeconds: z.number().int(),
    /** Record tasks only: commands from the web page, oldest first (at most 20 per reply). An older agent never receives any. */
    commands: z.array(RecordCommand).max(20).optional(),
    /** Device tasks only (additive, optional): what the explorer asked of the phone, oldest first. An agent that is not running a device task never receives any. */
    deviceCommands: z.array(DeviceCommand).max(5).optional(),
    /** Protocol 2: the platform's time limit for this run passed. Stop now (cancel is true as well). */
    timeout: z.boolean().optional(),
    /** Protocol 2: this runner was retired. Finish what runs, take nothing new, then exit. */
    shutdown: z.boolean().optional(),
    /** Protocol 2: the runner's switches changed; they apply to the next task. */
    config: RunnerConfigPush.optional(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// ── result ──────────────────────────────────────────────────────────────────

export const UploadResponse = z.object({ ref: SafeName, size: z.number().int(), sha256: z.string() });
export type UploadResponse = z.infer<typeof UploadResponse>;

const ArtifactKind = z.enum(["screenshot", "trace", "video", "visual-actual", "visual-diff", "vision-shot", "evidence"]);

/** ScriptRun (src/engine/validation/runner.ts) with every local file path replaced by the name of an uploaded file. */
export const WireRun = z.object({
    testId: z.string(),
    status: z.enum(["passed", "failed", "timedOut", "skipped", "error"]),
    durationMs: z.number(),
    error: z.string().max(2000).optional(),
    failedStepIndex: z.number().int(),
    steps: z.array(z.object({ index: z.number().int(), title: z.string(), status: z.enum(["passed", "failed"]), error: z.string().max(800).optional() })).max(500),
    artifacts: z.array(z.object({ kind: ArtifactKind, ref: SafeName })).max(50),
    vision: z.array(z.object({ step: z.number().int(), ref: SafeName, expected: z.string().optional() })).max(20).optional(),
    notes: z.array(z.string().max(500)).max(50).optional(),
    newBaselines: z.array(z.object({ name: SafeName, ref: SafeName })).max(50).optional(),
    responses: z.array(z.object({ method: z.string(), path: z.string(), status: z.number(), obs: z.unknown().optional() })).max(500),
    metrics: z.array(z.object({ metric: z.string(), value: z.number(), unit: z.string(), budget: z.number().optional() })).max(100).optional(),
    variant: z.string().optional(),
    /** Cleanup ledger lines (ids and paths only), already executed by the agent when env.cleanup is "agent". */
    created: z.array(z.record(z.unknown())).max(500).optional(),
});
export type WireRun = z.infer<typeof WireRun>;

export const ResultRequest = z.object({
    /** false = the agent could not run the task at all (tooling missing, cancelled, crashed): a infrastructure problem, never a test verdict. */
    ok: z.boolean(),
    /** Plain-words reason when ok is false (at most 500 chars). */
    error: z.string().max(500).optional(),
    runs: z.array(WireRun).max(500),
    /** The browser web tests of this run used (additive, optional; web runs only). The platform shows it in the run details. */
    browser: WebBrowserUsed.optional(),
    /** Protocol 2: the attempt this result is for. A result for an attempt that is no longer current is refused with 409 (superseded). */
    attemptId: z.string().max(64).optional(),
});
export type ResultRequest = z.infer<typeof ResultRequest>;

// ── protocol 2 ──────────────────────────────────────────────────────────────
//
// Additive to protocol 1; only an agent that said `protocols: [.., 2]` in hello and was answered `protocol: 2` uses it.
//
//   POST /api/agent/tasks/:id/accept     AcceptRequest   -> AcceptResponse      within TaskOffer.acceptSeconds, or the task goes back to the queue
//   POST /api/agent/tasks/:id/reject     RejectRequest   -> { ok: true }        the task is offered to another runner; it fails only when none is left
//   POST /api/agent/tasks/:id/events     EventsRequest   -> EventsResponse      live progress, stored once per (task, attempt, seq)
//
// Uploads carry the attempt in the header `x-attempt-id`. A heartbeat, upload, event or result for an attempt that is no longer the
// current one gets 409 with `{ error, details: { code: "superseded" } }`, and the agent stops that attempt. A result posted again for the same attempt
// gets 200 `{ ok: true, alreadyReceived: true }`, so an agent may repeat it until it hears an answer.

export const ATTEMPT_HEADER = "x-attempt-id";
/** The `code` of a 409 answer for a message of an attempt that is no longer the current one. */
export const SUPERSEDED = "superseded";

/** Every phase of a runner task, written only by the platform. The last seven are final. */
export const TASK_PHASES = ["queued", "assigned", "accepted", "preparing", "running", "uploading", "completed", "rejected", "failed", "cancelled", "timed_out", "lost_connection"] as const;
export type TaskPhase = (typeof TASK_PHASES)[number];
export const FINAL_TASK_PHASES: readonly TaskPhase[] = ["completed", "rejected", "failed", "cancelled", "timed_out", "lost_connection"];

const AttemptId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const AcceptRequest = z.object({ attemptId: AttemptId });
export type AcceptRequest = z.infer<typeof AcceptRequest>;
export const AcceptResponse = z.object({ ok: z.literal(true), leaseSeconds: z.number().int() });
export type AcceptResponse = z.infer<typeof AcceptResponse>;

/** Why a runner will not take a task (the sentence says it in plain words; it is shown in the run's events). */
export const REJECT_REASONS = ["missing-browser", "missing-tools", "code-scripts-off", "private-target", "busy", "no-display", "unsupported", "other"] as const;
export const RejectRequest = z.object({
    attemptId: AttemptId,
    reason: z.enum(REJECT_REASONS),
    message: z.string().trim().min(1).max(300),
});
export type RejectRequest = z.infer<typeof RejectRequest>;

const TestRef = { testId: z.string().min(1).max(80), variant: z.string().max(60).optional() };
const Seq = { seq: z.number().int().min(0).max(10_000_000), at: z.string().max(40) };
const StepStatus = z.enum(["passed", "failed"]);
const RunStatus = z.enum(["passed", "failed", "timedOut", "skipped", "error"]);

/** One live event of a run. `seq` counts from 0 per attempt; the platform keeps each (task, attempt, seq) once. */
export const LiveEvent = z.discriminatedUnion("type", [
    z.object({ type: z.literal("test_started"), ...Seq, ...TestRef, title: z.string().max(300).optional() }),
    z.object({ type: z.literal("test_finished"), ...Seq, ...TestRef, title: z.string().max(300).optional(), status: RunStatus, durationMs: z.number().min(0), error: z.string().max(2000).optional(), stack: z.string().max(4000).optional() }),
    z.object({ type: z.literal("step_started"), ...Seq, ...TestRef, index: z.number().int().min(0).max(10_000), title: z.string().max(300) }),
    z.object({ type: z.literal("step_finished"), ...Seq, ...TestRef, index: z.number().int().min(0).max(10_000), title: z.string().max(300), status: StepStatus, durationMs: z.number().min(0), error: z.string().max(800).optional() }),
    z.object({ type: z.literal("log"), ...Seq, line: z.string().max(300) }),
    /** A file already uploaded for this attempt (PUT .../files/:name); `ref` is the name it was uploaded under. */
    z.object({ type: z.literal("screenshot"), ...Seq, ...TestRef, ref: SafeName, step: z.number().int().min(0).max(10_000).optional(), kind: z.enum(["screenshot", "vision-shot", "visual-actual", "visual-diff"]).optional() }),
    z.object({ type: z.literal("phase"), ...Seq, phase: AgentPhase }),
]);
export type LiveEvent = z.infer<typeof LiveEvent>;
export type LiveEventType = LiveEvent["type"];

export const MAX_EVENTS_PER_BATCH = 100;
export const EventsRequest = z.object({ attemptId: AttemptId, events: z.array(LiveEvent).min(1).max(MAX_EVENTS_PER_BATCH) });
export type EventsRequest = z.infer<typeof EventsRequest>;
export const EventsResponse = z.object({ ok: z.literal(true), stored: z.number().int(), duplicates: z.number().int() });
export type EventsResponse = z.infer<typeof EventsResponse>;

/** A repeated result for the same attempt (additive answer field). */
export const ResultResponse = z.object({ ok: z.literal(true), alreadyReceived: z.boolean().optional() });
export type ResultResponse = z.infer<typeof ResultResponse>;

/**
 * The job event kinds live events become on the platform (`agent_events.kind`; the run's stream carries them with their `data`, and a
 * refresh replays them). `runner_step` carries `state: "started" | "finished"`. `runner_phase` and `runner_attempt` are written by the
 * platform itself (a phase change, a new hand-out, a rejection, a re-offer).
 */
export const LIVE_EVENT_KINDS: Record<LiveEventType, string> = {
    test_started: "runner_test_started",
    test_finished: "runner_test_finished",
    step_started: "runner_step",
    step_finished: "runner_step",
    log: "runner_log",
    screenshot: "runner_screenshot",
    phase: "runner_phase",
};
