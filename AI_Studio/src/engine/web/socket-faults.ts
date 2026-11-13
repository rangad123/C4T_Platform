/**
 * Deliberate faults for live apps (testing the tests, see ../mutation/faults.ts): a test of a page that gets its data over a WebSocket
 * should notice when that socket breaks, and a test should notice when the network goes away.
 *   socket-drop   every WebSocket the page opens is closed at once (as a server that went away)
 *   socket-error  the socket connects to the real server, but every message the page receives is replaced by an error frame
 *   offline       the browser goes offline just before the action the checked step depends on
 * Only what the browser receives changes: the page's own messages still reach the server unchanged (Playwright's routeWebSocket).
 * A socket fault in a test whose page opens no socket did not take effect and does not count (the same rule as the other faults).
 */
import { renderWithAdapter } from "../frameworks/index.js";
import type { RenderContext } from "../generators/index.js";
import { keyStep } from "../mutation/faults.js";
import type { TestSpec } from "../spec/schema.js";
import type { ScriptInput } from "../validation/runner.js";

export const SOCKET_FAULT_KINDS = ["socket-drop", "socket-error", "offline"] as const;
export type SocketFaultKind = (typeof SOCKET_FAULT_KINDS)[number];
export const isSocketFault = (kind: string): kind is SocketFaultKind => (SOCKET_FAULT_KINDS as readonly string[]).includes(kind);

/** The same text as faults.ts NOT_APPLIED (kept literal here: the two modules import each other). */
const NOT_APPLIED = "DELIBERATE_FAULT_NOT_APPLIED";
export const SOCKET_ERROR_FRAME = '{"type":"error","error":"Deliberate fault: the server sent an error"}';

/** The faults of this kind a test gets: the socket ones only when the application was seen opening a WebSocket. */
export function socketFaults(appUsesWebSockets: boolean): Array<{ kind: SocketFaultKind; label: string }> {
    return [
        ...(appUsesWebSockets
            ? [
                  { kind: "socket-drop" as const, label: "the page's live connection (WebSocket) drops" },
                  { kind: "socket-error" as const, label: "the page's live connection (WebSocket) sends an error instead of its data" },
              ]
            : []),
        { kind: "offline" as const, label: "the browser goes offline" },
    ];
}

const HELPER = `
// ── Deliberate fault (testing the test): only what the browser receives is changed, never what is sent ──
const SOCKET_FAULT = { kind: "", applied: false };
test.beforeEach(() => { SOCKET_FAULT.applied = false; });
test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "passed" && !SOCKET_FAULT.applied) throw new Error(${JSON.stringify(NOT_APPLIED)});
});
async function faultSockets(page: import("@playwright/test").Page): Promise<void> {
    await page.routeWebSocket(/.*/, (ws) => {
        SOCKET_FAULT.applied = true;
        if (SOCKET_FAULT.kind === "socket-drop") return void ws.close({ code: 1011, reason: "Deliberate fault" });
        const server = ws.connectToServer();
        server.onMessage(() => ws.send(${JSON.stringify(SOCKET_ERROR_FRAME)}));
    });
}
async function faultOffline(page: import("@playwright/test").Page): Promise<void> {
    await page.context().setOffline(true);
    SOCKET_FAULT.applied = true;
}
`;

function before(content: string, n: number, line: string): string | undefined {
    const marker = `\n    evidenceStep(page, ${n});\n`;
    const at = content.indexOf(marker);
    return at < 0 ? undefined : `${content.slice(0, at)}\n    ${line}${content.slice(at)}`;
}

/** The test's script with one socket or offline fault built in; undefined when it has no checked step or not the expected shape. */
export function socketFaultScript(spec: TestSpec, render: RenderContext, kind: SocketFaultKind): ScriptInput | undefined {
    const k = keyStep(spec);
    if (!k) return undefined;
    // Offline before opening a page fails at the opening, which says nothing about the test's check.
    if (kind === "offline" && spec.steps[k.trigger]?.action === "navigate") return undefined;
    const script = renderWithAdapter(spec, "playwright", render);
    let content: string | undefined = before(script.content + HELPER, 1, `SOCKET_FAULT.kind = ${JSON.stringify(kind)};`);
    // Sockets open as the page loads: the route is in place before the first step. Offline starts at the action the check depends on.
    if (content) content = kind === "offline" ? before(content, k.trigger + 1, "await faultOffline(page);") : before(content, 1, "await faultSockets(page);");
    if (!content) return undefined;
    return { testId: `${spec.testId}~fault-${kind}`, filename: script.filename.replace(/\.spec\.ts$/, `.fault-${kind}.spec.ts`), content, framework: "playwright" };
}
