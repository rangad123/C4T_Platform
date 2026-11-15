import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
// @ts-expect-error plain JavaScript script (no type declarations)
import { acquireDist, acquireLock, heldWith, isHeld } from "../scripts/lock.mjs";

type Release = (() => void) & { token: string };

/**
 * Builds take turns on this machine (every checkout): the build waits for the "build" lock unless its caller already holds it, then
 * for this checkout's "dist" guard (exclusive), so it never replaces web/dist while a browser-test file of this checkout is using it.
 */
function buildLock(): Plugin {
    const releases: Release[] = [];
    let before: string | undefined;
    const done = () => {
        if (!releases.length) return;
        if (before === undefined) delete process.env.AITP_LOCK_HELD;
        else process.env.AITP_LOCK_HELD = before;
        for (const r of releases.reverse()) r();
        releases.length = 0;
    };
    return {
        name: "aitp-build-lock",
        apply: "build",
        async buildStart() {
            before = process.env.AITP_LOCK_HELD;
            try {
                if (!isHeld("build")) {
                    const build = (await acquireLock("build", { label: "vite build web" })) as Release;
                    releases.push(build);
                    process.env.AITP_LOCK_HELD = heldWith("build", build.token);
                }
                const dist = (await acquireDist("write", { label: "vite build web" })) as Release;
                releases.push(dist);
                process.env.AITP_LOCK_HELD = heldWith("dist", dist.token);
            } catch (e) {
                done();
                throw e;
            }
        },
        buildEnd(error) {
            if (error) done();
        },
        closeBundle: done,
    };
}

export default defineConfig({
    plugins: [react(), buildLock()],
    server: { port: 5173, proxy: { "/api": "http://127.0.0.1:4000" } },
    build: { outDir: "dist", emptyOutDir: true },
});
