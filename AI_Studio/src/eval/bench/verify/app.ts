/** Starting, resetting and stopping a benchmark application (examples/bench-*), loopback only. Used by the tests and the benchmark controller. */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BenchApp = "bench-shop" | "bench-rbac";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
export const BENCH_SERVER: Record<BenchApp, string> = {
    "bench-shop": path.join(ROOT, "examples/bench-shop/server.mjs"),
    "bench-rbac": path.join(ROOT, "examples/bench-rbac/server.mjs"),
};

/** How the sign-in and registration forms are sent: html (default: plain POST then 303) or js (the page script calls the JSON API). */
export type BenchLogin = "html" | "js";

export interface RunningBenchApp {
    app: BenchApp;
    base: string;
    port: number;
    /** "none", "all" or a comma-separated list of defect ids. */
    defects: string;
    login: BenchLogin;
    reset(): Promise<void>;
    stop(): Promise<void>;
}

const listening = (port: number) =>
    new Promise<boolean>((resolve) => {
        const s = net.connect(port, "127.0.0.1", () => (s.destroy(), resolve(true)));
        s.on("error", () => resolve(false));
    });

export async function startBenchApp(app: BenchApp, port: number, defects = "none", resetToken = "bench-reset", login: BenchLogin = "html"): Promise<RunningBenchApp> {
    if (await listening(port)) throw new Error(`port ${port} is already in use`);
    const child: ChildProcess = spawn(process.execPath, [BENCH_SERVER[app], String(port)], {
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "", BENCH_DEFECTS: defects, BENCH_RESET_TOKEN: resetToken, BENCH_LOGIN: login },
    });
    let up = false;
    for (let i = 0; i < 80 && !up; i++) {
        up = await listening(port);
        if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    if (!up) {
        child.kill();
        throw new Error(`${app} did not start on ${port}`);
    }
    const base = `http://127.0.0.1:${port}`;
    return {
        app,
        base,
        port,
        defects,
        login,
        async reset() {
            const r = await fetch(`${base}/__bench/reset`, { method: "POST", headers: { "x-bench-reset": resetToken } });
            if (r.status !== 200) throw new Error(`reset of ${app} failed: ${r.status}`);
        },
        async stop() {
            if (child.exitCode !== null || child.signalCode !== null) return;
            await new Promise<void>((resolve) => {
                child.once("exit", () => resolve());
                child.kill();
            });
        },
    };
}
