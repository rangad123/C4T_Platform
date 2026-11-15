// The locks everyone on one machine takes turns with, across checkouts and processes:
//   build    building web/dist, any checkout (the web build takes it on its own: web/vite.config.ts)
//   browser  starting browsers: browser-tier test files (tests/browser-lock.setup.ts), scripts/e2e.ts, scripts/eval.mjs
//   dist     one per checkout, shared/exclusive: a browser-test file of a checkout reads its web/dist (shared, many at once), a web build
//            of that checkout replaces it (exclusive: it waits until no test file of that checkout is reading, and new readers wait for it)
// Used by scripts/with-lock.mjs (the command-line form for build and browser); `node scripts/lock-status.mjs` lists who holds what.
//
// The lock folder is /tmp/aitp-locks on every checkout and process whatever TMPDIR says (Windows: %ProgramData%\aitp-locks); AITP_LOCK_DIR
// is the only override. It is created with mode 0700 and refused when it is a symbolic link, belongs to another user or is open to other
// users: every checkout runs as one user, and a folder others can write to would let them fake or block a lock. There is no fallback path.
//
// A lock is one file <dir>/<name> (JSON: pid, host, token, command, checkout, since), written in full under a temporary name and then
// hard-linked into place: the link fails when the name is taken, so it never overwrites anyone's lock. The holder touches the file every
// 15 s, after checking it is still its own: a holder that was stopped (Ctrl+Z, SIGSTOP) or hung long enough to have its lock cleared finds
// that out at its next heartbeat and exits (LOST_LOCK_EXIT) instead of running on without the lock.
// A lock is abandoned when its holder's process is gone (same machine), or when nobody touched it for STALE_MS; while a process
// with the holder's pid still runs on this machine, that age alone is not enough (the machine may just have slept): the one waiting must
// also watch the heartbeat stand still for CONFIRM_MS of its own running time. An abandoned lock
// is cleared under <name>.reaping, a hard link to the lock file taken the same way (one clearer at a time, bound to that very file):
// the clearer looks again through its link and removes the lock only when it is still the abandoned one. A live lock is never moved,
// not even for a moment. (A directory <name>/owner is a lock left by an older copy of this script; it is read and cleared too.)
// A holder passes AITP_LOCK_HELD=<name>:<token>,... to what it starts; a child asking for a lock its parent holds (same token) goes
// straight on. Order: build < browser < dist. A process holding a lock may not then wait for an earlier one (that is how two runs would
// wait for each other forever). Waiting says who holds the lock, how long they have held it, and gives up after AITP_LOCK_TIMEOUT_MIN
// minutes (default 180: longer than the daily benchmark holds "browser") with an error naming the holder.
// Waiters take turns first come, first served: each writes a ticket <name>.queue/<time>-<token> (its owner JSON) and only the earliest
// live ticket may take the lock, so a run that gives the lock back and asks again at once (a test run taking it file by file) goes
// behind everyone already waiting. A waiter touches its ticket at every look; a ticket whose process is gone, or untouched for
// TICKET_STALE_MS (a waiter stopped with Ctrl+Z), is cleared, and a waiter that finds its own ticket cleared queues again at the back.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** A lock untouched for this long is abandoned; with a running process of its pid (reused pid, hung holder) only after CONFIRM_MS more. */
export const STALE_MS = 20 * 60_000;
const BEAT_MS = 15_000;
/** How long a waiter watches the old heartbeat of a holder whose pid still runs before clearing its lock: two heartbeats. Measured on
 * the clock that stands still while the machine sleeps, so a holder waking from a long sleep always gets to touch its lock first. */
export const CONFIRM_MS = 2 * BEAT_MS;
/** Locks a process must take in this order; a lock missing here can be taken at any time. */
export const ORDER = ["build", "browser", "dist"];
export const DEFAULT_TIMEOUT_MIN = 180;
/** The one lock folder of this machine (not os.tmpdir(): that follows TMPDIR, which differs between shells and tools). */
export const DEFAULT_LOCK_DIR = process.platform === "win32" ? path.join(process.env.ProgramData || "C:\\ProgramData", "aitp-locks") : "/tmp/aitp-locks";

export const lockDir = (env = process.env) => (env.AITP_LOCK_DIR ? path.resolve(env.AITP_LOCK_DIR) : DEFAULT_LOCK_DIR);
export const lockName = (name) => String(name).replace(/[^\w-]/g, "");
/** How long to wait for a lock (AITP_LOCK_TIMEOUT_MIN minutes, default 180); throws a plain error for a value that is not a number above 0. */
export const timeoutMs = (env = process.env) => {
    const raw = env.AITP_LOCK_TIMEOUT_MIN;
    if (raw === undefined || String(raw).trim() === "") return DEFAULT_TIMEOUT_MIN * 60_000;
    const min = Number(raw);
    if (!Number.isFinite(min) || min <= 0)
        throw new Error(`AITP_LOCK_TIMEOUT_MIN must be a number of minutes above 0 (for example 240), not ${JSON.stringify(String(raw))}.`);
    return min * 60_000;
};

/** Throws a plain error unless `dir` is a real directory of this user that nobody else can write to. */
export function checkLockDir(dir) {
    const st = fs.lstatSync(dir);
    const fix = "Remove it (or set AITP_LOCK_DIR to a folder of your own) and run again.";
    if (st.isSymbolicLink()) throw new Error(`The lock folder ${dir} is a symbolic link; locks are not kept behind a link. ${fix}`);
    if (!st.isDirectory()) throw new Error(`The lock folder ${dir} is not a folder. ${fix}`);
    if (process.platform === "win32") return;
    if (st.uid !== process.getuid())
        throw new Error(`The lock folder ${dir} belongs to another user (uid ${st.uid}); another user could fake or block its locks. ${fix}`);
    if (st.mode & 0o077)
        throw new Error(`The lock folder ${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}). Run \`chmod 700 ${dir}\` and run again.`);
}

/** Create the lock folder (mode 0700) if it is missing, then check it (checkLockDir). Never falls back to another folder. */
export function ensureLockDir(dir) {
    try {
        if (dir !== DEFAULT_LOCK_DIR) fs.mkdirSync(path.dirname(dir), { recursive: true });
        fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
        if (e?.code !== "EEXIST") throw new Error(`Could not create the lock folder ${dir}: ${e?.message ?? e}`);
    }
    checkLockDir(dir);
    return dir;
}

/** name -> token of the locks this process's starter says it holds (AITP_LOCK_HELD). */
function heldTokens(env) {
    const out = new Map();
    for (const item of (env.AITP_LOCK_HELD ?? "").split(",")) {
        const [name, token] = item.split(":");
        if (name && token) out.set(name, token);
    }
    return out;
}

/** The owner JSON of a lock: the lock file itself, or <lock>/owner for a lock directory left by an older copy of this script. */
function readOwner(lock) {
    try {
        return JSON.parse(fs.readFileSync(lock, "utf8"));
    } catch (e) {
        if (e?.code !== "EISDIR" && e?.code !== "EPERM" && e?.code !== "EACCES") return undefined;
        try {
            return JSON.parse(fs.readFileSync(path.join(lock, "owner"), "utf8"));
        } catch {
            return undefined;
        }
    }
}

/** The file whose modification time is the lock's heartbeat: the lock file (or an old lock directory's owner file, else the directory). */
function beatFile(lock) {
    try {
        if (!fs.statSync(lock).isDirectory()) return lock;
    } catch {
        return lock;
    }
    return fs.existsSync(path.join(lock, "owner")) ? path.join(lock, "owner") : lock;
}

const exists = (file) => {
    try {
        fs.lstatSync(file);
        return true;
    } catch {
        return false;
    }
};

/** Take `lock` for `owner` (JSON text) if nobody holds it: written in full first, then hard-linked into place, which never overwrites.
 * Throws a plain error when the folder cannot hold hard links at all (the link is refused although the name is free). */
function take(lock, owner) {
    const tmp = `${lock}.new-${crypto.randomUUID()}`;
    fs.writeFileSync(tmp, owner, { flag: "wx", mode: 0o600 });
    try {
        for (let again = 0; ; again++) {
            try {
                fs.linkSync(tmp, lock);
                marksSeen.delete(`${lock}.reaping`);
                return true;
            } catch (e) {
                if (["EEXIST", "ENOTEMPTY", "EISDIR"].includes(e?.code)) return false;
                if (e?.code !== "EPERM") throw e;
                if (exists(lock)) return false;
                // Refused with the name free: once more (a lock may have come and gone in between), then it is the file system.
                if (again)
                    throw new Error(
                        `The lock folder ${path.dirname(lock)} does not allow hard links (${e.message}), and the locks need them. ` +
                            "Set AITP_LOCK_DIR to a folder on an ordinary local file system, or leave it unset to use the default folder.",
                    );
            }
        }
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

/** True when this process (or the process that started it) holds the lock right now: its token is the lock's current owner token. */
export function isHeld(name, env = process.env) {
    const n = lockName(name);
    const token = heldTokens(env).get(n);
    if (!token) return false;
    if (n === "dist") return distHeldBy(token, env);
    return readOwner(path.join(lockDir(env), n))?.token === token;
}

/** The AITP_LOCK_HELD value for the children of a process that holds `name` with `token` (release.token). */
export function heldWith(name, token, env = process.env) {
    const m = heldTokens(env);
    m.set(lockName(name), token);
    return [...m].map(([n, t]) => `${n}:${t}`).join(",");
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e?.code === "EPERM";
    }
}

/** Old heartbeats of holders whose pid still runs, as this process saw them: owner token -> { beat, at } (at: performance.now()). */
const quietSeen = new Map();

/** True once this process has watched the heartbeat `beat` of the holder `token` stand still for `confirmMs` of running time. */
function stoodStill(token, beat, confirmMs) {
    const key = String(token);
    const seen = quietSeen.get(key);
    if (!seen || seen.beat !== beat) {
        if (quietSeen.size > 200) quietSeen.clear();
        quietSeen.set(key, { beat, at: performance.now() });
        return confirmMs <= 0;
    }
    return performance.now() - seen.at >= confirmMs;
}

/** Who holds what the owner file `file` describes, and whether it is abandoned; undefined when the file is gone. */
function holderFrom(name, file, owner, confirmMs = CONFIRM_MS) {
    let beat;
    try {
        beat = fs.statSync(file).mtimeMs;
    } catch {
        return undefined;
    }
    const beatAgeMs = Date.now() - beat;
    const running = owner && owner.host === os.hostname() ? alive(owner.pid) : undefined;
    // No owner: the taker is between creating the directory and writing the file, unless that was a while ago (it crashed there).
    let stale = owner ? running === false || beatAgeMs > STALE_MS : beatAgeMs > 60_000;
    // A process with the holder's pid runs here: an old heartbeat alone proves nothing (after the machine slept, a waiter looks before
    // the holder's next heartbeat). It is abandoned only when the heartbeat also stands still while this process watches.
    if (stale && owner && running === true) stale = stoodStill(owner.token, beat, confirmMs);
    return { name, owner, beatAgeMs, running, stale };
}

/** Who holds the lock and whether it is abandoned; undefined when the lock is free. */
export function holderOf(name, env = process.env, confirmMs = CONFIRM_MS) {
    const lock = path.join(lockDir(env), lockName(name));
    return holderFrom(lockName(name), beatFile(lock), readOwner(lock), confirmMs);
}

/** Every build/browser lock in the lock folder with its holder, and every checkout's dist guard in use. Throws when the folder is unsafe. */
export function lockStatus(env = process.env) {
    const dir = lockDir(env);
    let entries = [];
    try {
        checkLockDir(dir);
        entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => (e.isFile() || e.isDirectory()) && !e.name.includes("."));
    } catch (e) {
        if (e?.code === "ENOENT") return { locks: [], dists: [] };
        throw e;
    }
    const locks = entries.filter((e) => !e.name.startsWith("dist-")).map((e) => holderOf(e.name, env)).filter(Boolean);
    const dists = entries.filter((e) => e.isDirectory() && e.name.startsWith("dist-")).map((e) => distState(path.join(dir, e.name)));
    return { locks, dists: dists.filter((d) => d.writer || d.readers.length) };
}

export const ago = (ms) => {
    if (ms < 90_000) return `${Math.round(ms / 1000)} s`;
    const min = Math.round(ms / 60_000);
    return min < 90 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
};
/** One line about a holder: pid, command, since when and for how long, checkout. */
export function describeHolder(h) {
    if (!h?.owner) return "a run that is just starting";
    const o = h.owner;
    const since = new Date(o.since);
    return `pid ${o.pid}${o.host !== os.hostname() ? ` on ${o.host}` : ""} (${o.command || "unnamed"}) since ${since.toLocaleTimeString()} (held for ${ago(Date.now() - since.getTime())}) in ${o.checkout}`;
}

/** A clearer's mark seen by this process: path -> { ino, changed, at }. A mark still there (same file, made at the same moment)
 * MARK_LEFT_MS later was left by a clearer that died between its two steps (a live one holds it for a few milliseconds), and is removed.
 * The file number alone is not enough: a later lock can get the number of an earlier one, and its clearer's mark would look old at once.
 * (`changed` is the file's change time, which making the mark sets.) An entry is dropped when this process takes or clears the lock. */
const marksSeen = new Map();
export const MARK_LEFT_MS = 5000;

function clearLeftMark(mark, log) {
    let ino, changed;
    try {
        const st = fs.lstatSync(mark);
        ino = st.ino;
        changed = st.ctimeMs;
    } catch {
        marksSeen.delete(mark);
        return;
    }
    const seen = marksSeen.get(mark);
    if (!seen || seen.ino !== ino || seen.changed !== changed) {
        marksSeen.set(mark, { ino, changed, at: Date.now() });
        return;
    }
    if (Date.now() - seen.at < MARK_LEFT_MS) return;
    marksSeen.delete(mark);
    fs.rmSync(mark, { force: true });
    log?.(`[lock] removed ${path.basename(mark)}, left by a run that died while clearing an abandoned lock`);
}

/**
 * Clear the abandoned lock `lock` whose owner token was `staleToken`. Only one clearer at a time: it takes <lock>.reaping (a hard link to
 * the lock file, so it names that very file), reads the owner through it, and removes the lock only when it is still that abandoned one
 * and the lock name still points at the same file. A lock taken afresh meanwhile is never moved or removed. True when the lock is gone.
 */
export function reapAbandoned(lock, staleToken, log, confirmMs = CONFIRM_MS) {
    let st;
    try {
        st = fs.lstatSync(lock);
    } catch {
        return true;
    }
    const mark = `${lock}.reaping`;
    const legacy = st.isDirectory();
    try {
        if (legacy) fs.writeFileSync(mark, "", { flag: "wx", mode: 0o600 });
        else fs.linkSync(lock, mark);
    } catch (e) {
        if (e?.code === "ENOENT") return true;
        if (e?.code === "EEXIST") clearLeftMark(mark, log);
        return false;
    }
    marksSeen.delete(mark); // this process holds the mark now: nothing it saw there earlier says anything about the next one
    try {
        const at = legacy ? lock : mark;
        const owner = readOwner(at);
        if (owner?.token !== staleToken || !holderFrom("", legacy ? beatFile(lock) : mark, owner, confirmMs)?.stale) return false;
        if (!legacy) {
            let ino;
            try {
                ino = fs.statSync(mark).ino;
            } catch {
                return false; // the mark was taken away under this clearer: leave the lock, the next look decides again
            }
            try {
                if (fs.lstatSync(lock).ino === ino) fs.unlinkSync(lock);
            } catch {
                /* gone already */
            }
            return true;
        }
        // A directory left by an older copy of this script: move it aside, and if what moved is not the abandoned one (an older copy
        // took it in between), put it back only when the name is still free.
        const grave = `${lock}.stale-${crypto.randomUUID()}`;
        try {
            fs.renameSync(lock, grave);
        } catch {
            return false;
        }
        if (readOwner(grave)?.token === staleToken) fs.rmSync(grave, { recursive: true, force: true });
        else if (!fs.existsSync(lock)) fs.renameSync(grave, lock);
        return true;
    } finally {
        fs.rmSync(mark, { force: true });
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Refuse to wait for `n` while holding a lock that comes after it in ORDER. */
function checkOrder(n, env) {
    const later = ORDER.includes(n) ? ORDER.slice(ORDER.indexOf(n) + 1).filter((l) => isHeld(l, env)) : [];
    if (!later.length) return;
    if (later[0] === "dist")
        throw new Error(
            `This run reads or builds web/dist (the "dist" guard) and now asks for "${n}"; take "${n}" before the guard (order: ${ORDER.join(" < ")}), or two runs could wait for each other forever.`,
        );
    throw new Error(
        `This run holds the "${later[0]}" lock and now asks for "${n}"; two runs doing that could wait for each other forever. Take both in one go, in order: node scripts/with-lock.mjs ${[n, ...later].join(",")} -- <command> (for example: with-lock build,browser -- sh -c "npx vite build web && npx vitest run tests/<file>").`,
    );
}

/** Waiting lines: at once, then every 30 s for 5 minutes, then every 5 minutes (a wait behind the daily benchmark lasts an hour). */
function waitLogger(log) {
    let told = -1;
    return (waited, line) => {
        const slot = waited < 5 * 60_000 ? Math.floor(waited / 30_000) : 10 + Math.floor(waited / (5 * 60_000));
        if (slot === told) return;
        told = slot;
        log(line(waited >= 1000 ? ` (${ago(waited)} so far)` : ""));
    };
}

/** Exit code of a process that found its lock cleared under it (see heartbeat). */
export const LOST_LOCK_EXIT = 4;
const exitOnLost = (message) => {
    console.error(message);
    process.exit(LOST_LOCK_EXIT);
};

/**
 * Touch `file` every `beatMs` (BEAT_MS) so nobody takes the lock as abandoned; never keeps the process alive. Each beat first checks that
 * the file is still this holder's (`token`). A holder that was stopped or hung (Ctrl+Z, SIGSTOP, a debugger) for longer than STALE_MS +
 * CONFIRM_MS may have had its lock cleared and taken by someone else; on resuming, its next beat finds that out and calls
 * onLost(message) (default: print the message and exit with LOST_LOCK_EXIT) instead of running on without the lock. It never touches
 * someone else's lock. Returns { beat (the timer), beatNow() (the same check and touch at once; false when the lock is lost) }.
 */
function heartbeat(file, token, { what = "", beatMs = BEAT_MS, onLost = exitOnLost } = {}) {
    let lost = false;
    const beatNow = () => {
        if (lost) return false;
        const owner = readOwner(file);
        if (owner?.token !== token) {
            lost = true;
            clearInterval(beat);
            const now = owner ? `; ${describeHolder({ owner })} holds it now` : "";
            onLost(
                `[lock${what ? ` ${what}` : ""}] this run's lock was cleared while the run was stopped or hung (its heartbeat stood still for over ${ago(STALE_MS)})${now}. ` +
                    "Stopping here instead of going on without the lock; run it again.",
            );
            return false;
        }
        try {
            const t = new Date();
            fs.utimesSync(file, t, t);
        } catch {
            /* released meanwhile */
        }
        return true;
    };
    const beat = setInterval(beatNow, beatMs);
    beat.unref();
    return { beat, beatNow };
}

/** Wrap a release function: once only, stops the heartbeat, and also runs at process exit. release.check() runs a heartbeat at once. */
function releaser({ beat, beatNow }, free, token) {
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        clearInterval(beat);
        process.off("exit", release);
        free();
    };
    release.token = token;
    release.check = () => released || beatNow();
    process.on("exit", release);
    return release;
}

/** A queue ticket untouched for this long belongs to a waiter that is gone or stopped: it is cleared so the queue moves on. */
export const TICKET_STALE_MS = 60_000;

/** Write a ticket for `owner` (JSON text) in `queue`, named so that tickets sort in the order they were written (microseconds, then token). */
function enqueue(queue, token, owner) {
    for (let again = 0; ; again++) {
        const at = String(Math.floor((performance.timeOrigin + performance.now()) * 1000)).padStart(17, "0");
        const file = path.join(queue, `${at}-${token}`);
        const tmp = path.join(queue, `.new-${token}`);
        try {
            fs.mkdirSync(queue, { recursive: true, mode: 0o700 });
            fs.writeFileSync(tmp, owner, { mode: 0o600 });
            fs.renameSync(tmp, file);
            return file;
        } catch (e) {
            if (e?.code !== "ENOENT" || again > 20) throw e; // the empty queue folder was removed in between: make it again
        }
    }
}

/** Remove the queue folder once nobody waits in it (a waiter writing its first ticket meanwhile makes it again). */
function dropEmptyQueue(queue) {
    try {
        fs.rmdirSync(queue);
    } catch {
        /* someone is waiting, or it is gone */
    }
}

/** The live tickets of `queue` in order (stale ones are removed on the way). */
function liveTickets(queue) {
    let names = [];
    try {
        names = fs.readdirSync(queue).filter((f) => !f.startsWith(".")).sort();
    } catch {
        return [];
    }
    const live = [];
    for (const f of names) {
        const file = path.join(queue, f);
        let st;
        try {
            st = fs.statSync(file);
        } catch {
            continue;
        }
        const owner = readJson(file);
        const gone = owner?.host === os.hostname() && !alive(owner.pid);
        if (gone || Date.now() - st.mtimeMs > TICKET_STALE_MS) {
            fs.rmSync(file, { force: true });
            continue;
        }
        live.push({ file, owner });
    }
    return live;
}

/**
 * Wait for the lock and take it. Returns release() (with release.token for heldWith), which removes the lock only while it is still
 * this holder's. While waiting it says who holds the lock and for how long (log). Gives up after timeoutMs (default
 * AITP_LOCK_TIMEOUT_MIN) with an error naming the holder.
 */
export async function acquireLock(name, { label = "", env = process.env, pollMs = 1000, timeoutMs: limitMs, confirmMs = CONFIRM_MS, log = (s) => console.error(s), beatMs, onLost } = {}) {
    const n = lockName(name);
    if (n === "dist") throw new Error('The "dist" guard is taken with acquireDist("read" | "write").');
    checkOrder(n, env);
    const limit = limitMs ?? timeoutMs(env);
    const dir = ensureLockDir(lockDir(env));
    const lock = path.join(dir, n);
    const token = crypto.randomUUID();
    const started = Date.now();
    const tell = waitLogger(log);
    const queue = `${lock}.queue`;
    const owner = () => JSON.stringify({ pid: process.pid, host: os.hostname(), token, command: String(label).slice(0, 200), checkout: ROOT, since: new Date().toISOString() });
    let ticket = enqueue(queue, token, owner());
    try {
        for (;;) {
            try {
                const now = new Date();
                fs.utimesSync(ticket, now, now);
            } catch {
                ticket = enqueue(queue, token, owner()); // cleared while this process was stopped: to the back of the queue
            }
            const tickets = liveTickets(queue);
            const ahead = tickets.findIndex((t) => t.file === ticket);
            if (ahead === 0) {
                if (take(lock, owner())) break;
            }
            const h = holderOf(n, env, confirmMs);
            if (h?.stale && reapAbandoned(lock, h.owner?.token, log, confirmMs)) {
                log(`[lock ${n}] cleared an abandoned lock left by ${describeHolder(h)}`);
                continue;
            }
            const waited = Date.now() - started;
            if (waited >= limit)
                throw new Error(
                    `Gave up waiting for the "${n}" lock after ${ago(waited)}. It is held by ${describeHolder(h)}${ahead > 0 ? `, and ${plural(ahead, "run waits", "runs wait")} before this one` : ""}. ` +
                        "See every holder with `node scripts/lock-status.mjs`; wait longer with AITP_LOCK_TIMEOUT_MIN=<minutes>.",
                );
            const queued = ahead > 0 ? ` (${plural(ahead, "run is", "runs are")} waiting before this one)` : "";
            if (h) tell(waited, (so) => `[lock ${n}] waiting${so} for ${describeHolder(h)}${queued}`);
            else if (ahead > 0) tell(waited, (so) => `[lock ${n}] waiting${so}: ${plural(ahead, "run was", "runs were")} waiting first`);
            await sleep(Math.min(pollMs, Math.max(1, limit - waited)));
        }
    } finally {
        fs.rmSync(ticket, { force: true });
        dropEmptyQueue(queue);
    }
    // A long run (the release gate, the benchmark: an hour or more) keeps touching the lock so nobody takes it as abandoned.
    return releaser(
        heartbeat(lock, token, { what: n, beatMs, onLost }),
        () => {
            if (readOwner(lock)?.token === token) fs.rmSync(lock, { force: true });
        },
        token,
    );
}

/**
 * For a long script (scripts/e2e.ts, scripts/eval.mjs): hold the lock for the rest of this process, unless its caller already holds
 * it, and mark it held for everything the script starts. Released when the process exits.
 */
export async function holdLock(name, label) {
    if (isHeld(name)) return;
    const release = await acquireLock(name, { label });
    process.env.AITP_LOCK_HELD = heldWith(name, release.token);
}

// ---- The per-checkout dist guard ----
// <lock dir>/dist-<hash of the checkout path>/ holds "checkout" (the path, for lock-status), "readers/<token>" (one owner JSON per
// reading test file) and "writer" (the build: one owner file, taken and cleared like a lock). A reader adds its file, then looks for a writer: if there is one it takes its file
// back and waits. A writer creates writer/ first (from then on no new reader gets in), then waits until no reader file is left. Either
// side looks after writing its own mark, so the two never both go ahead. Abandoned marks (dead pid, stopped heartbeat) are cleared.

const distBase = (checkout, env) => path.join(lockDir(env), `dist-${crypto.createHash("sha256").update(path.resolve(checkout)).digest("hex").slice(0, 16)}`);

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
        return undefined;
    }
}

/** The dist guard's writer (or undefined) and its readers (each with stale). */
function distState(base) {
    const readersDir = path.join(base, "readers");
    let names = [];
    try {
        names = fs.readdirSync(readersDir).filter((f) => !f.includes("."));
    } catch {
        /* none */
    }
    const readers = names
        .map((f) => ({ file: path.join(readersDir, f), ...holderFrom("dist", path.join(readersDir, f), readJson(path.join(readersDir, f))) }))
        .filter((r) => r.beatAgeMs !== undefined)
        .sort((a, b) => String(a.owner?.since).localeCompare(String(b.owner?.since)) || a.file.localeCompare(b.file));
    const writer = holderFrom("dist", beatFile(path.join(base, "writer")), readOwner(path.join(base, "writer")));
    let checkout = "";
    try {
        checkout = fs.readFileSync(path.join(base, "checkout"), "utf8");
    } catch {
        /* not yet written */
    }
    return { base, checkout, writer, readers };
}

function distHeldBy(token, env, checkout = ROOT) {
    const base = distBase(checkout, env);
    return fs.existsSync(path.join(base, "readers", token)) || readOwner(path.join(base, "writer"))?.token === token;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Take the dist guard of `checkout` (default: this checkout): "read" for a browser-test file (shared), "write" for a web build
 * (exclusive). A process whose caller already holds it (AITP_LOCK_HELD dist token) goes straight on, and a build ignores the reader its
 * own caller holds. Waiting lines, the timeout and the error work as for acquireLock. Returns release() with release.token.
 */
export async function acquireDist(mode, { label = "", env = process.env, checkout = ROOT, pollMs = 1000, timeoutMs: limitMs, log = (s) => console.error(s), beatMs, onLost } = {}) {
    if (mode !== "read" && mode !== "write") throw new Error(`acquireDist: mode must be "read" or "write", not ${mode}`);
    checkOrder("dist", env);
    const mine = heldTokens(env).get("dist");
    const reentered = !!mine && distHeldBy(mine, env, checkout);
    // A reader inside a holder of either kind, or a writer inside a writer, goes straight on.
    if (reentered && (mode === "read" || readOwner(path.join(distBase(checkout, env), "writer"))?.token === mine)) {
        const noop = () => {};
        noop.token = mine;
        return noop;
    }
    const limit = limitMs ?? timeoutMs(env);
    ensureLockDir(lockDir(env));
    const base = distBase(checkout, env);
    const readersDir = path.join(base, "readers");
    fs.mkdirSync(readersDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(base, "checkout"))) fs.writeFileSync(path.join(base, "checkout"), path.resolve(checkout));
    const token = crypto.randomUUID();
    const owner = JSON.stringify({ pid: process.pid, host: os.hostname(), token, command: String(label).slice(0, 200), checkout: path.resolve(checkout), since: new Date().toISOString() });
    const started = Date.now();
    const tell = waitLogger(log);
    const writerDir = path.join(base, "writer");
    const otherWriter = () => {
        const w = distState(base).writer;
        if (w?.stale && reapAbandoned(writerDir, w.owner?.token, log)) {
            log(`[lock dist] cleared an abandoned web build left by ${describeHolder(w)}`);
            return undefined;
        }
        return w;
    };
    const giveUp = (waited, what) =>
        new Error(
            `Gave up waiting for web/dist of ${path.resolve(checkout)} after ${ago(waited)}: ${what}. ` +
                "See every holder with `node scripts/lock-status.mjs`; wait longer with AITP_LOCK_TIMEOUT_MIN=<minutes>.",
        );

    if (mode === "read") {
        const file = path.join(readersDir, token);
        for (;;) {
            let w = otherWriter();
            if (!w) {
                fs.writeFileSync(file, owner, { flag: "wx" });
                w = otherWriter();
                if (!w) break;
                fs.rmSync(file, { force: true });
            }
            const waited = Date.now() - started;
            if (waited >= limit) throw giveUp(waited, `a web build of this checkout is replacing it: ${describeHolder(w)}`);
            tell(waited, (so) => `[lock dist] waiting${so} for the web build of this checkout to finish: ${describeHolder(w)}`);
            await sleep(Math.min(pollMs, Math.max(1, limit - waited)));
        }
        return releaser(heartbeat(file, token, { what: "dist", beatMs, onLost }), () => fs.rmSync(file, { force: true }), token);
    }

    // write: first the writer mark (no new reader gets in from here), then wait for the readers to finish.
    for (;;) {
        if (take(writerDir, owner)) break;
        const w = otherWriter();
        if (!w) continue;
        const waited = Date.now() - started;
        if (waited >= limit) throw giveUp(waited, `another web build of this checkout holds it: ${describeHolder(w)}`);
        tell(waited, (so) => `[lock dist] waiting${so} for another web build of this checkout: ${describeHolder(w)}`);
        await sleep(Math.min(pollMs, Math.max(1, limit - waited)));
    }
    const beat = heartbeat(writerDir, token, { what: "dist", beatMs, onLost });
    const free = () => {
        if (readOwner(writerDir)?.token === token) fs.rmSync(writerDir, { force: true });
    };
    const tellReaders = waitLogger(log);
    for (;;) {
        const readers = [];
        for (const r of distState(base).readers) {
            if (mine && r.owner?.token === mine) continue; // the reader this build's own caller holds
            if (r.stale) {
                fs.rmSync(r.file, { force: true });
                log(`[lock dist] cleared an abandoned reader left by ${describeHolder(r)}`);
            } else readers.push(r);
        }
        if (!readers.length) break;
        const waited = Date.now() - started;
        const who = `${plural(readers.length, "browser-test run is", "browser-test runs are")} using web/dist of this checkout: ${readers.map(describeHolder).join("; ")}`;
        if (waited >= limit) {
            clearInterval(beat.beat);
            free();
            throw giveUp(waited, who);
        }
        tellReaders(waited, (so) => `[lock dist] web build waiting${so}: ${who}`);
        await sleep(Math.min(pollMs, Math.max(1, limit - waited)));
    }
    return releaser(beat, free, token);
}
