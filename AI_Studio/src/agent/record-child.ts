/**
 * Hosts one recording session on this computer (started by the agent for a record task; talks to it over IPC, see child-protocol.ts).
 *
 * It runs the same recorder core the platform uses for a local recording. The safety rules that make sense here apply: only http(s) pages, no credentials in
 * an address, the step and time caps, passwords and one-time codes never read in the page (the core's private binding), no cookies or storage recorded.
 * The platform's address guard does not apply: this computer's own network is the point. Nothing the person typed is ever logged.
 */
import { chromium } from "playwright";
import type { LiveResultWire, RecordCommand } from "../agent-protocol/schema.js";
import { clip } from "../engine/recorder/model.js";
import { RecorderError, RecorderSession, type RecState } from "../engine/recorder/session.js";
import type { RecordFromChild, RecordStart, RecordToChild } from "./child-protocol.js";

const send = (m: RecordFromChild): Promise<void> => new Promise((resolve) => (process.send ? process.send(m, () => resolve()) : resolve()));

/** Only web pages with no credentials in the address. A different scheme (file:, chrome:, javascript:) is refused before the browser opens it. */
export async function webOnlyGuard(raw: string): Promise<void> {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new RecorderError(400, "That is not a valid address.");
    }
    if (!/^https?:$/.test(u.protocol)) throw new RecorderError(400, "Only http and https pages can be recorded.");
    if (u.username || u.password) throw new RecorderError(400, "The address must not contain a user name or password.");
}

let session: RecorderSession | undefined;
let acked: string[] = [];
let timer: NodeJS.Timeout | undefined;
let finishing = false;
/** Commands run one at a time, in the order they came. */
let chain: Promise<void> = Promise.resolve();
const seen = new Set<string>();

function push(): void {
    timer = undefined;
    if (!session) return;
    const state: RecState = session.state();
    const ended = state.status === "stopped" || state.status === "failed";
    const ids = acked;
    acked = [];
    void send({ type: "state", state, ...(session.pid ? { pid: session.pid } : {}), acked: ids, ...(ended ? { ended: true } : {}) }).then(() => {
        // The browser is closed and its process id was checked before the status flipped: the session is over.
        if (ended && !finishing) {
            finishing = true;
            setTimeout(() => process.exit(0), 50);
        }
    });
}

/** State goes to the agent within a moment of a change (changes arrive in bursts while a person types). */
function schedule(): void {
    if (timer) return;
    timer = setTimeout(push, 60);
}

/** An action or a snapshot asked for by a tool: the answer goes back to the platform as a result (never logged: it may show the page). */
async function drive(s: RecorderSession, c: Extract<RecordCommand, { type: "act" | "snapshot" }>): Promise<LiveResultWire> {
    try {
        if (c.type === "snapshot") return { id: c.id, ok: true, snapshot: await s.snapshot({ image: c.image }) };
        const out = await s.act(c.action, { ...(c.secret !== undefined ? { secret: c.secret, ...(c.origins ? { origins: c.origins } : {}) } : {}), ...(c.image ? { image: true } : {}) });
        return { id: c.id, ok: true, recorded: out.recorded, ...(out.step ? { step: out.step } : {}), ...(out.note ? { note: clip(out.note, 300) } : {}), snapshot: out.snapshot };
    } catch (e) {
        if (e instanceof RecorderError) return { id: c.id, ok: false, status: e.status, error: clip(e.message, 400) };
        return { id: c.id, ok: false, status: 422, error: "The agent could not do that." };
    }
}

async function apply(c: RecordCommand): Promise<void> {
    const s = session;
    if (!s) return;
    try {
        switch (c.type) {
            case "act":
            case "snapshot":
                await send({ type: "result", result: await drive(s, c) });
                break;
            case "inspect":
                await s.setInspect({ on: c.on, ...(c.mode ? { mode: c.mode } : {}), ...(c.check ? { check: c.check } : {}) });
                break;
            case "patch":
                await s.patchStep(c.index, { ...(c.locator ? { locator: c.locator } : {}), ...(c.value !== undefined ? { value: c.value } : {}), ...(c.assert ? { assert: c.assert } : {}) });
                break;
            case "delete":
                s.deleteStep(c.index);
                break;
            case "stop":
                await s.stop();
                break;
            case "discard":
                await s.discard();
                break;
        }
    } catch (e) {
        // A refused command (a step that is gone, a recording that ended) is answered like any other: the new state shows what happened.
        if (!(e instanceof RecorderError)) await send({ type: "log", line: "A command from the page could not be applied." });
    }
    acked.push(c.id);
    schedule();
}

process.on("message", (raw) => {
    const m = raw as RecordToChild;
    if (m?.type === "record") start(m);
    else if (m?.type === "command" && !seen.has(m.command.id)) {
        seen.add(m.command.id);
        chain = chain.then(() => apply(m.command));
    } else if (m?.type === "stop") chain = chain.then(() => session?.stop());
});

// The agent went away: end the session (closes the browser) and leave, so nothing is left running.
process.on("disconnect", () => {
    void session?.discard().finally(() => process.exit(1));
    setTimeout(() => process.exit(1), 10_000).unref();
});

function start(m: RecordStart): void {
    if (session) return;
    // Test seam (never set in normal use): publish the browser on a local DevTools port so a test can drive the page like a person.
    const debugPort = Number(process.env.AITP_AGENT_RECORD_DEBUG_PORT);
    const debug = Number.isInteger(debugPort) && debugPort > 1023 && debugPort < 65536;
    // The runner's browser setting: the computer's Chrome or Edge when it uses one (see browser-setup.ts), else Playwright's own Chromium.
    const chosen = { ...(m.browser?.channel ? { channel: m.browser.channel } : {}), ...(m.browser?.executablePath ? { executablePath: m.browser.executablePath } : {}) };
    const launch = debug || Object.keys(chosen).length ? (headless: boolean) => chromium.launch({ headless, ...chosen, ...(debug ? { args: [`--remote-debugging-port=${debugPort}`] } : {}) }) : undefined;
    session = new RecorderSession({
        startUrl: m.startUrl,
        ...(launch ? { launch } : {}),
        headed: m.headed,
        guard: webOnlyGuard,
        // The person's own network applies (proxies, single sign-on): pages are fetched by the browser itself.
        interceptRequests: false,
        caps: { idleMs: m.idleMs, totalMs: m.totalMs, maxSteps: m.maxSteps },
        onChange: schedule,
    });
    session.start();
    schedule();
}
