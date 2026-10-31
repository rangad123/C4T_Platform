/**
 * The process that hosts one recording session, seen from the agent (the counterpart of task-process.ts for record tasks).
 *
 * Why a process per task: the browser the session opens is a child of this process, so killing the process tree ends the browser too, and a crash or a hang
 * in the recorder cannot take the agent down. Only this process's tree is ever touched, by the process id the agent itself started.
 */
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RecordFromChild, RecordToChild } from "./child-protocol.js";
import { childEnvFrom, killTree } from "./task-process.js";

const ENTRY = fileURLToPath(new URL("./record-child.mjs", import.meta.url));

/** A window on a Linux desktop needs more of the person's session than a headless run does. Passed to the recording process only (never the token). */
const DISPLAY_ENV = ["XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP"];
/** Test seam: a port on 127.0.0.1 where the recorded browser can be reached over the DevTools protocol, so a test can play the person (see record-child.ts). */
export const RECORD_DEBUG_PORT_ENV = "AITP_AGENT_RECORD_DEBUG_PORT";

export class RecordProcess {
    private readonly child: ChildProcess;
    private tail = "";
    private exited = false;
    /** Resolves when the process has exited (whatever the reason). */
    readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

    constructor(source: NodeJS.ProcessEnv, onMessage: (m: RecordFromChild) => void, entry: string = ENTRY) {
        const extra = Object.fromEntries(Object.entries(source).filter(([k, v]) => v !== undefined && (DISPLAY_ENV.includes(k.toUpperCase()) || k === RECORD_DEBUG_PORT_ENV)));
        this.child = fork(entry, [], {
            env: { ...childEnvFrom(source), ...extra },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        const keep = (d: Buffer) => {
            this.tail = `${this.tail}${d}`.slice(-1500);
        };
        this.child.stdout?.on("data", keep);
        this.child.stderr?.on("data", keep);
        this.child.on("message", (raw) => {
            const m = raw as RecordFromChild;
            if (m && (m.type === "state" || m.type === "log" || m.type === "result")) onMessage(m);
        });
        this.exit = new Promise((resolve) => {
            this.child.on("error", () => {
                this.exited = true;
                resolve({ code: null, signal: null });
            });
            this.child.on("exit", (code, signal) => {
                this.exited = true;
                resolve({ code, signal });
            });
        });
    }

    get pid(): number | undefined {
        return this.child.pid;
    }

    get hasExited(): boolean {
        return this.exited;
    }

    /** What the process wrote to its output (for a crash; the caller masks it). */
    get output(): string {
        return this.tail;
    }

    send(m: RecordToChild): void {
        if (this.exited || !this.child.connected) return;
        try {
            this.child.send(m);
        } catch {
            /* the process is going away */
        }
    }

    /** Ends the process and everything it started (the browser), now. */
    kill(): void {
        killTree(this.child);
    }
}
