// Run a command while holding a named lock, so parallel developers take turns at things that cannot overlap
// (building web/dist, or running browser-heavy tests on a small machine).
//   node scripts/with-lock.mjs <name> -- node <script> [args...]     (plain node commands only, no shell)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 1 || sep === argv.length - 1) {
    console.error("usage: node scripts/with-lock.mjs <name> -- <command> [args...]");
    process.exit(2);
}
const name = argv[0].replace(/[^\w-]/g, "");
const cmd = argv.slice(sep + 1);
// Re-entrant: a command already running under this lock (the test-tier runner starts vitest through this script) runs straight away.
const held = (process.env.AITP_LOCK_HELD ?? "").split(",").filter(Boolean);
if (held.includes(name)) {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 1));
    child.on("error", (e) => { console.error(e); process.exit(2); });
} else {
const dir = path.join(process.cwd(), ".scratch", "locks");
fs.mkdirSync(dir, { recursive: true });
const lock = path.join(dir, name);
const STALE_MS = 20 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let waited = 0;
for (;;) {
    try {
        fs.mkdirSync(lock);
        fs.writeFileSync(path.join(lock, "owner"), `${process.pid} ${new Date().toISOString()} ${cmd.join(" ").slice(0, 200)}`);
        break;
    } catch {
        // A lock older than STALE_MS belongs to a crashed run.
        try {
            if (Date.now() - fs.statSync(lock).mtimeMs > STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
        } catch {
            /* released meanwhile */
        }
        if (waited % 30_000 === 0 && waited > 0) console.error(`[lock ${name}] waiting for another run to finish (${waited / 1000}s)...`);
        await sleep(2000);
        waited += 2000;
    }
}
// Heartbeat: a lock is "stale" when untouched for STALE_MS, so a long run (the release gate takes over an hour) keeps touching it;
// without this, a second runner would delete a live lock after 20 minutes and two browser runs would overlap.
const beat = setInterval(() => {
    try {
        const now = new Date();
        fs.utimesSync(lock, now, now);
    } catch {
        /* released */
    }
}, 60_000);
const release = () => { clearInterval(beat); fs.rmSync(lock, { recursive: true, force: true }); };
process.on("SIGINT", () => { release(); process.exit(130); });
const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, AITP_LOCK_HELD: [...held, name].join(",") } });
child.on("exit", (code) => { release(); process.exit(code ?? 1); });
child.on("error", (e) => { release(); console.error(e); process.exit(2); });
}
