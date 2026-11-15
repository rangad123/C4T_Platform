// Run a command while holding named locks, so everyone on this machine (every checkout) takes turns at things that cannot overlap:
// "build" for building web/dist, "browser" for anything that starts browsers.
//   node scripts/with-lock.mjs <name>[,<name>...] -- <command> [args...]     (no shell; use `sh -c "..."` for several commands)
//   node scripts/with-lock.mjs build,browser -- sh -c "npx vite build web && npx vitest run tests/<file>"   (build, then browser tests)
// Several locks are taken in the fixed order (build before browser) and given back in reverse. The lock itself is scripts/lock.mjs;
// `node scripts/lock-status.mjs` lists who holds what. Browser-tier vitest files, the web build, scripts/e2e.ts and scripts/eval.mjs
// take their lock on their own, so forgetting this script makes them wait, not overlap.
// A lock cleared while this script was stopped or hung (see scripts/lock.mjs) is noticed at the next heartbeat and on resuming (SIGCONT):
// the command is told to stop (SIGTERM, then SIGKILL) and this script exits with LOST_LOCK_EXIT (4) instead of going on without the lock.
import { spawn } from "node:child_process";
import os from "node:os";
import tty from "node:tty";
import { acquireLock, heldWith, isHeld, lockName, LOST_LOCK_EXIT, ORDER } from "./lock.mjs";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep !== 1 || sep === argv.length - 1) {
    console.error("usage: node scripts/with-lock.mjs <name>[,<name>...] -- <command> [args...]");
    process.exit(2);
}
const rank = (n) => (ORDER.includes(n) ? ORDER.indexOf(n) : -1);
const names = [...new Set(argv[0].split(",").map(lockName).filter(Boolean))].sort((a, b) => rank(a) - rank(b));
const cmd = argv.slice(sep + 1);

const ms = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
const releases = [];
const env = { ...process.env };
/** Set when a lock was found cleared under this script: the exit code, whatever the command's own. */
let lostCode;
/** Called by a heartbeat that finds its lock taken away (set up below once the command runs). */
let onLostCommand;
const onLost = (message) => {
    console.error(message);
    if (lostCode !== undefined) return;
    lostCode = LOST_LOCK_EXIT;
    if (onLostCommand) return onLostCommand();
    releaseAll(); // still waiting for a later lock: nothing has started yet
    process.exit(LOST_LOCK_EXIT);
};
const releaseAll = () => {
    for (const r of releases.reverse()) r();
    releases.length = 0;
};
// Re-entrant: a lock this command's caller already holds (the test-tier runner starts vitest through this script) is not taken again.
for (const name of names) {
    if (isHeld(name, env)) continue;
    try {
        const release = await acquireLock(name, { label: cmd.join(" "), env, onLost, beatMs: ms("AITP_WITH_LOCK_BEAT_MS", undefined) });
        releases.push(release);
        env.AITP_LOCK_HELD = heldWith(name, release.token, env);
    } catch (e) {
        releaseAll();
        console.error(`[lock ${name}] ${e instanceof Error ? e.message : e}`);
        process.exit(3);
    }
}

let finished = false;
const done = (code) => {
    if (finished) return;
    finished = true;
    releaseAll();
    process.exit(lostCode ?? code);
};
// Not on a terminal (CI, scripts, agents), the command runs in a process group of its own (not on Windows), so everything it starts can
// be reached and waited for: with `sh -c "a && b"` the shell is the command, and a signal to the shell alone would leave b and its
// browsers running. On a terminal (stdin is one), the command stays in this script's group, the terminal's foreground job: a command in
// a group of its own would be stopped by the terminal (SIGTTIN, SIGTTOU) as soon as it reads input or sets a terminal mode (an npx
// prompt, raw mode), and Ctrl+Z would stop this script only. There the terminal's own Ctrl+C, Ctrl+Z and hang-up reach every process of
// the job, and this script passes on the signals sent to it alone, waiting for the command itself.
// Browsers Playwright starts run in process groups of their own in both cases, so they are not waited for here: what keeps two runs'
// browsers apart is the launch guard (tests/fixtures/browser-launch-guard.ts), which refuses a start without the browser lock's token.
const grouped = process.platform !== "win32" && !tty.isatty(0);
const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, detached: grouped });
/** True while any process of the command's group is left (the command itself, or what it started and left behind). On a terminal (no
 * group of its own) only the command itself is waited for. */
const groupAlive = () => {
    if (!grouped || !child.pid) return false;
    try {
        process.kill(-child.pid, 0);
        return true;
    } catch (e) {
        return e?.code === "EPERM";
    }
};
const signalAll = (sig) => {
    try {
        if (grouped && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
    } catch {
        /* nobody left */
    }
};
// The locks are given back only when the command and everything in its group have exited: a signal to this script (Ctrl+C, CI
// cancelling a job, a closed terminal, a kill of this pid alone) is passed on to the whole group, and the locks stay taken while it
// shuts its browsers down. A second signal of the same kind, or HARD_KILL_MS without the group ending, stops the group with SIGKILL
// (Windows: ends the command). A command that exits by itself and leaves processes behind is waited for LINGER_MS, then they are told
// to stop (SIGTERM, then SIGKILL after HARD_KILL_MS): the lock is never given back beside them.
const HARD_KILL_MS = ms("AITP_WITH_LOCK_HARD_KILL_MS", 60_000);
const LINGER_MS = ms("AITP_WITH_LOCK_LINGER_MS", 10_000);
let hardKill;
const hardKillLater = () => (hardKill ??= setTimeout(() => signalAll("SIGKILL"), HARD_KILL_MS));
const got = new Set();
child.on("exit", (code, signal) => {
    const result = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1);
    if (!groupAlive()) return done(result);
    console.error(`[lock] the command has exited, but processes it started are still running; keeping ${names.join(" and ")} until they are gone`);
    const since = Date.now();
    let told = false;
    setInterval(() => {
        if (!groupAlive()) return done(result);
        if (told || got.size || Date.now() - since < LINGER_MS) return; // after a signal the group was told already
        told = true;
        console.error("[lock] stopping the processes the command left behind");
        signalAll("SIGTERM");
        hardKillLater();
    }, 100);
});
child.on("error", (e) => {
    console.error(e);
    done(2);
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
        if (finished) return;
        if (got.has(sig)) {
            signalAll("SIGKILL");
            return;
        }
        got.add(sig);
        // On a terminal, Ctrl+C and a hang-up reached the whole job already; sending them again would count as a second Ctrl+C.
        if (grouped || sig === "SIGTERM") signalAll(sig);
        hardKillLater();
    });
}
// Ctrl+Z, or `kill -TSTP` of this pid: the command is stopped with this script (so it never runs on while the heartbeat stands still),
// and continued with it (fg, bg, `kill -CONT`). On resuming, the heartbeats look at once whether a lock was cleared meanwhile.
// The command's own group is a session of its own (detached), where the kernel drops SIGTSTP (an orphaned group), so it gets SIGSTOP.
process.on("SIGTSTP", () => {
    if (finished) return;
    signalAll(grouped ? "SIGSTOP" : "SIGTSTP");
    process.kill(process.pid, "SIGSTOP");
});
process.on("SIGCONT", () => {
    if (finished) return;
    signalAll("SIGCONT");
    for (const r of [...releases]) r.check?.();
});
onLostCommand = () => {
    got.add("lost");
    signalAll("SIGCONT");
    signalAll("SIGTERM");
    hardKillLater();
};
