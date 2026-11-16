/**
 * The benchmark applications (examples/bench-*) and the host that runs them for the controller: one child process per app on a loopback
 * port, restarted with another set of switched behaviours (`BENCH_DEFECTS`) for each replay, its in-memory data reset on every start and
 * through the guarded reset route. Only the processes started here are ever stopped, by their own handle.
 *
 * The sign-in details are the apps' own seeded fixture accounts (in the repository, not secrets). The workflows are the apps' areas by
 * address, used only to measure which areas the generated tests reached.
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../config.js";

export interface BenchApp {
    id: string;
    /** Server script, relative to the repository root. */
    script: string;
    /** The seeded account the exploration signs in with (none: the app is explored signed out). */
    credentials?: { username: string; password: string };
    /** Areas of the app by address prefix (a test reaches an area when it opens or calls an address under one of them). */
    workflows: Array<{ name: string; paths: string[] }>;
    /** Settings of the understanding benchmark only (the detection benchmark keeps `credentials` and the app's own data). */
    understanding?: UnderstandingSetup;
}

/** How the understanding benchmark lets a crawl reach what the app's answer key lists. */
export interface UnderstandingSetup {
    /** The seeded account its crawl signs in with, instead of `credentials`. */
    credentials?: { username: string; password: string };
    /** JSON requests sent as that account (signed in through POST /api/login) after the app starts and before the crawl. */
    seed?: Array<{ method: "POST" | "PUT"; path: string; body: Record<string, unknown> }>;
    /** Answer-key screens no crawl can reach, left out of U1, each with the reason. */
    notReachableScreens?: Array<{ id: string; why: string }>;
}

export const BENCH_APPS: BenchApp[] = [
    {
        id: "bench-shop",
        script: "examples/bench-shop/server.mjs",
        credentials: { username: "alice@example.test", password: "Password1!" },
        workflows: [
            { name: "Registration", paths: ["/register", "/api/register"] },
            { name: "Sign in", paths: ["/login", "/api/login"] },
            { name: "Product browsing", paths: ["/products", "/api/products"] },
            { name: "Cart", paths: ["/cart", "/api/cart"] },
            { name: "Checkout", paths: ["/checkout", "/api/checkout"] },
            { name: "Orders", paths: ["/orders", "/api/orders"] },
            { name: "Account", paths: ["/account", "/api/profile"] },
        ],
        understanding: {
            // The cart page shows "Check out" only with a line in the cart, and the seeded cart is empty.
            seed: [{ method: "POST", path: "/api/cart/items", body: { productId: "p1", quantity: 1 } }],
            notReachableScreens: [{ id: "checkout-review", why: "No page links to it: it opens only after the delivery-address form is sent, and a crawl sends no form." }],
        },
    },
    {
        id: "bench-rbac",
        script: "examples/bench-rbac/server.mjs",
        credentials: { username: "ana@example.test", password: "Password1!" },
        workflows: [
            { name: "Registration", paths: ["/register", "/api/register"] },
            { name: "Sign in", paths: ["/login", "/api/login"] },
            { name: "Notes", paths: ["/notes", "/api/notes"] },
            { name: "Administration", paths: ["/admin", "/api/admin"] },
            { name: "Account", paths: ["/account", "/api/me"] },
        ],
        // Every signed-in screen of the answer key lists the admin role, and People (/admin/users) lists only admin: an admin crawl can
        // reach all of them, the user account all but People. The detection benchmark keeps the user account its seeded defects need.
        // The admin owns no note in the app's data, and a note page shows its edit, share, stop-sharing and delete controls to the owner
        // only: one note of the admin's, shared with a colleague, puts them in reach. The app's data starts fresh, so it is note n4.
        understanding: {
            credentials: { username: "ada@example.test", password: "Password1!" },
            seed: [
                { method: "POST", path: "/api/notes", body: { title: "Release checklist", body: "Check the sign-in page before the release." } },
                { method: "POST", path: "/api/notes/n4/share", body: { email: "ben@example.test" } },
            ],
        },
    },
];

export const benchApp = (id: string): BenchApp | undefined => BENCH_APPS.find((a) => a.id === id);

/** The app's version: sha256 of its server script (first 16 hex digits). */
export function appVersion(app: Pick<BenchApp, "script">, root = REPO_ROOT): string {
    return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, app.script))).digest("hex").slice(0, 16);
}

/** Which areas the tests reach: the workflows with an address any test opened or called. */
export function workflowsReached(app: Pick<BenchApp, "workflows">, paths: string[]): string[] {
    const norm = paths.map((p) => p.replace(/\/+$/, "") || "/");
    return app.workflows.filter((w) => w.paths.some((wp) => norm.some((p) => p === wp || p.startsWith(`${wp}/`)))).map((w) => w.name);
}

export type Switches = "none" | "all" | string[];
const switchesEnv = (s: Switches): string => (Array.isArray(s) ? (s.length ? s.join(",") : "none") : s);

export class BenchAppHost {
    private child?: ChildProcess;
    private readonly token = crypto.randomBytes(16).toString("hex");
    readonly url: string;

    constructor(
        readonly app: BenchApp,
        readonly port: number,
        private readonly root = REPO_ROOT,
        /** How the app's sign-in form is sent: a plain HTML form (the default) or by script (BENCH_LOGIN=js, measured on its own). */
        private readonly login: "html" | "js" = "html",
    ) {
        this.url = `http://127.0.0.1:${port}`;
    }

    /** Start (or restart) the app with these behaviours switched on; resolves when it answers. Its data starts fresh. */
    async start(switches: Switches): Promise<void> {
        await this.stop();
        const child = spawn(process.execPath, [path.join(this.root, this.app.script), String(this.port)], {
            stdio: "ignore",
            env: { ...minimalEnv(), BENCH_DEFECTS: switchesEnv(switches), BENCH_RESET_TOKEN: this.token, BENCH_LOGIN: this.login },
        });
        this.child = child;
        for (let i = 0; i < 100; i++) {
            if (child.exitCode !== null) throw new Error(`${this.app.id} could not start on port ${this.port} (is the port in use?)`);
            try {
                if ((await fetch(this.url, { signal: AbortSignal.timeout(2000) })).status < 500) return;
            } catch {
                /* not listening yet */
            }
            await new Promise((r) => setTimeout(r, 100));
        }
        await this.stop();
        throw new Error(`${this.app.id} did not answer on ${this.url}`);
    }

    /** Fresh data without a restart (the guarded reset route). */
    async reset(): Promise<void> {
        const res = await fetch(`${this.url}/__bench/reset`, { method: "POST", headers: { "x-bench-reset": this.token }, signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`${this.app.id} refused the data reset (HTTP ${res.status})`);
    }

    async stop(): Promise<void> {
        const child = this.child;
        this.child = undefined;
        if (!child || child.exitCode !== null) return;
        const gone = new Promise((r) => child.once("exit", r));
        child.kill();
        await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
        // The port must be free before the next start on it.
        for (let i = 0; i < 30; i++) {
            try {
                await fetch(this.url, { signal: AbortSignal.timeout(300) });
                await new Promise((r) => setTimeout(r, 100));
            } catch {
                return;
            }
        }
    }
}

/** The app gets nothing of the controller's environment (no keys, no tokens): only what Node needs to run. */
function minimalEnv(): NodeJS.ProcessEnv {
    const keep = ["PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME"];
    return Object.fromEntries(keep.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
}
