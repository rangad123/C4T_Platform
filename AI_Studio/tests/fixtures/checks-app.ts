/** Starts examples/checks-app (the weak / hardened / SPA fixture for the health and security checks) as a child process. */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { REPO_ROOT } from "../../src/config.js";
import type { AppModel, PageModel } from "../../src/engine/understanding/app-model.js";

export type ChecksMode = "weak" | "hardened" | "spa";

/** Resolves once the server accepts connections. `tls` = name of a certificate under tests/fixtures/tls (https). */
export async function startChecksApp(port: number, mode: ChecksMode, tls?: string): Promise<ChildProcess> {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, "examples/checks-app/server.mjs"), String(port), mode, ...(tls ? [tls] : [])], { stdio: "ignore" });
    for (let i = 0; i < 60; i++) {
        const ok = await new Promise<boolean>((resolve) => {
            const s = net.connect(port, "127.0.0.1", () => (s.destroy(), resolve(true)));
            s.on("error", () => resolve(false));
        });
        if (ok) return child;
        await new Promise((r) => setTimeout(r, 150));
    }
    child.kill();
    throw new Error(`checks-app did not start on ${port}`);
}

/** A minimal application model: the pages the crawler "found". */
export function modelFor(origin: string, pages: Array<Partial<PageModel> & Pick<PageModel, "path" | "type">>, apis: AppModel["apis"] = []): AppModel {
    const full = pages.map((p): PageModel => ({
        url: `${origin}${p.path}`, title: "", depth: 1, status: 200, headings: [], forms: [], components: [], links: [],
        aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [], ...p,
    }));
    return {
        url: `${origin}/`, origin, siteType: "ecommerce", purpose: "shop", features: [], pages: full, navigation: [], apis, journeys: [],
        authentication: { required: false, mechanisms: [], loggedIn: false }, externalDependencies: [], documentedTestCases: [],
        stats: { pagesVisited: full.length, pagesSkipped: 0, apisFound: apis.length, durationMs: 0 },
    };
}
