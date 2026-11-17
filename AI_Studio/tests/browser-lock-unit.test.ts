/**
 * The machine-wide locks (scripts/lock.mjs): every checkout on a machine meets the same lock, an abandoned lock is cleared, waiting
 * says who holds the lock and gives up with a plain error, "build" and "browser" are separate and taken in that order, a child of a
 * holder re-enters by token, browser-tier test files, the web build, scripts/e2e.ts and scripts/eval.mjs wait their turn, and a browser
 * start without the lock is refused. No browser is started and no AI is called (the scripts are stopped or fail before either).
 * Also: the per-checkout web/dist guard (browser-test files read, a build of the same checkout writes), the fixed lock folder whatever
 * TMPDIR says and its safety checks, the 180-minute default wait, and the CI watch that fails when a browser process starts.
 * Every lock lives in a temporary AITP_LOCK_DIR; the real /tmp/aitp-locks is never created here.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error plain JavaScript script (no type declarations)
import { acquireDist, acquireLock, ago, CONFIRM_MS, DEFAULT_LOCK_DIR, ensureLockDir, heldWith, holderOf, isHeld, lockDir, lockStatus, MARK_LEFT_MS, reapAbandoned, ROOT, STALE_MS, TICKET_STALE_MS, timeoutMs } from "../scripts/lock.mjs";
// @ts-expect-error plain JavaScript script (no type declarations)
import { browsersUnder } from "../scripts/no-browser-watch.mjs";
import { guardBrowserLaunch, UNLOCKED_LAUNCH_MESSAGE } from "./fixtures/browser-launch-guard.js";

type Release = (() => void) & { token: string };
const root = ROOT as string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let tmp: string;
let locks: string;
const savedEnv = { held: process.env.AITP_LOCK_HELD, dir: process.env.AITP_LOCK_DIR };
const quiet = () => {};

beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-lock-"));
    locks = path.join(tmp, "locks");
});
afterAll(() => {
    if (savedEnv.held === undefined) delete process.env.AITP_LOCK_HELD;
    else process.env.AITP_LOCK_HELD = savedEnv.held;
    if (savedEnv.dir === undefined) delete process.env.AITP_LOCK_DIR;
    else process.env.AITP_LOCK_DIR = savedEnv.dir;
    fs.rmSync(tmp, { recursive: true, force: true });
});

/** This process's environment without the variables vitest sets for its own workers (a child vitest must start fresh). */
const cleanEnv = (): NodeJS.ProcessEnv =>
    Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("VITEST") && k !== "TEST" && k !== "NODE_ENV" && k !== "AITP_LOCK_DIR"));

/** Run a child process to the end; resolves with its exit code and output. */
function run(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const done = new Promise<{ code: number | null; out: string }>((r) => child.on("close", (code) => r({ code, out })));
    return { child, done, output: () => out };
}

async function until(what: () => boolean, ms = 30_000) {
    const end = Date.now() + ms;
    while (!what()) {
        if (Date.now() > end) throw new Error("timed out");
        await sleep(100);
    }
}

/** A lock file written by hand, as a holder would leave it (legacy: the directory <name>/owner an older copy of the script made). */
function fakeHolder(dir: string, name: string, owner: Record<string, unknown>, beatAgeMs = 0, legacy = false) {
    ensureLockDir(dir);
    if (legacy) fs.mkdirSync(path.join(dir, name), { recursive: true });
    const file = legacy ? path.join(dir, name, "owner") : path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify({ host: os.hostname(), token: "old-token", command: "an old run", checkout: "/elsewhere", since: new Date().toISOString(), ...owner }));
    const t = new Date(Date.now() - beatAgeMs);
    fs.utimesSync(file, t, t);
}

/** The pid of a process that has exited. */
async function deadPid() {
    const { child, done } = run(process.execPath, ["-e", ""], { cwd: tmp, env: {} });
    await done;
    return child.pid!;
}

describe("the lock", () => {
    it("a second taker waits until the first gives it back; release never removes someone else's lock", async () => {
        const env = { AITP_LOCK_DIR: locks };
        const first = await acquireLock("unit", { env, pollMs: 50, log: quiet });
        let second: Release | undefined;
        const p = acquireLock("unit", { env, pollMs: 50, log: quiet }).then((r: Release) => (second = r));
        await sleep(400);
        expect(second).toBeUndefined();
        first();
        await p;
        expect(fs.existsSync(path.join(locks, "unit"))).toBe(true);
        first(); // a late second release by the old holder leaves the new holder's lock alone
        expect(fs.existsSync(path.join(locks, "unit"))).toBe(true);
        second!();
        expect(fs.existsSync(path.join(locks, "unit"))).toBe(false);
    });

    it("is machine-wide: two checkouts with different TMPDIR values take turns on one lock", async () => {
        const checkouts = ["checkout-a", "checkout-b"].map((c) => {
            fs.mkdirSync(path.join(tmp, c, "scripts"), { recursive: true });
            for (const f of ["lock.mjs", "with-lock.mjs"]) fs.copyFileSync(path.join(root, "scripts", f), path.join(tmp, c, "scripts", f));
            fs.mkdirSync(path.join(tmp, c, "own-tmp"));
            return path.join(tmp, c);
        });
        const envFor = (c: string) => ({ ...cleanEnv(), TMPDIR: path.join(c, "own-tmp"), TMP: path.join(c, "own-tmp"), TEMP: path.join(c, "own-tmp"), AITP_LOCK_DIR: locks, AITP_LOCK_HELD: "" });
        const log = path.join(tmp, "turns.log");
        const work = (who: string) =>
            `const fs=require("fs");fs.appendFileSync(${JSON.stringify(log)},"start ${who} "+Date.now()+"\\n");setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},"end ${who} "+Date.now()+"\\n"),1500)`;
        const a = run(process.execPath, [path.join(checkouts[0], "scripts", "with-lock.mjs"), "browser", "--", process.execPath, "-e", work("a")], { cwd: tmp, env: envFor(checkouts[0]) });
        await until(() => fs.existsSync(log));
        const b = run(process.execPath, [path.join(checkouts[1], "scripts", "with-lock.mjs"), "browser", "--", process.execPath, "-e", work("b")], { cwd: os.homedir(), env: envFor(checkouts[1]) });
        const [ra, rb] = await Promise.all([a.done, b.done]);
        expect(ra.code, ra.out).toBe(0);
        expect(rb.code, rb.out).toBe(0);
        const at = Object.fromEntries(fs.readFileSync(log, "utf8").trim().split("\n").map((l) => [l.split(" ").slice(0, 2).join(" "), Number(l.split(" ")[2])]));
        expect(at["start b"]).toBeGreaterThanOrEqual(at["end a"]);
        // The waiting line names the holder: pid, command, since when and for how long, checkout.
        expect(rb.out).toMatch(new RegExp(`\\[lock browser\\] waiting for pid ${a.child.pid} \\(.*-e .*\\) since .* \\(held for \\d+ s\\) in ${checkouts[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        expect(fs.readdirSync(locks).filter((n) => n === "browser")).toEqual([]);
        for (const c of checkouts) expect(fs.readdirSync(path.join(c, "own-tmp"))).toEqual([]);
    }, 30_000);

    it("without AITP_LOCK_DIR every process resolves the one fixed folder, whatever TMPDIR, TMP or the working folder say", async () => {
        expect(DEFAULT_LOCK_DIR).toBe(process.platform === "win32" ? path.join(process.env.ProgramData || "C:\\ProgramData", "aitp-locks") : "/tmp/aitp-locks");
        expect(lockDir({})).toBe(DEFAULT_LOCK_DIR);
        expect(lockDir({ TMPDIR: path.join(tmp, "x") })).toBe(DEFAULT_LOCK_DIR);
        expect(lockDir({ AITP_LOCK_DIR: "" })).toBe(DEFAULT_LOCK_DIR);
        expect(lockDir({ AITP_LOCK_DIR: locks })).toBe(locks);
        // Separate processes, each with its own TMPDIR: only resolved, nothing is created.
        const lockMod = JSON.stringify(path.join(root, "scripts", "lock.mjs"));
        const seen = new Set<string>();
        for (const t of ["tmp-one", "tmp-two", "tmp-three"]) {
            const own = path.join(tmp, t);
            fs.mkdirSync(own);
            const env = { ...cleanEnv(), TMPDIR: own, TMP: own, TEMP: own }; // cleanEnv() has no AITP_LOCK_DIR
            const r = await run(process.execPath, ["--input-type=module", "-e", `const m=await import(${lockMod});const os=await import("node:os");process.stdout.write(JSON.stringify([m.lockDir(),os.tmpdir()]))`], { cwd: own, env }).done;
            const [dir, osTmp] = JSON.parse(r.out);
            expect(osTmp).toBe(own); // the temporary folder really differs
            seen.add(dir);
        }
        expect([...seen]).toEqual([DEFAULT_LOCK_DIR]);
    }, 30_000);

    it.skipIf(process.platform === "win32")("creates the lock folder 0700, and refuses a symbolic link, a foreign-owned or an open folder without falling back", async () => {
        const fresh = path.join(tmp, "safe", "locks");
        await acquireLock("browser", { env: { AITP_LOCK_DIR: fresh }, log: quiet }).then((r: Release) => r());
        expect(fs.statSync(fresh).mode & 0o777).toBe(0o700);
        const target = path.join(tmp, "safe", "elsewhere");
        fs.mkdirSync(target, { mode: 0o700 });
        const link = path.join(tmp, "safe", "link");
        fs.symlinkSync(target, link);
        await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: link }, log: quiet })).rejects.toThrow(/The lock folder .*link is a symbolic link/);
        await expect(acquireDist("read", { env: { AITP_LOCK_DIR: link }, log: quiet })).rejects.toThrow(/is a symbolic link/);
        expect(fs.readdirSync(target)).toEqual([]);
        const open = path.join(tmp, "safe", "open");
        fs.mkdirSync(open);
        fs.chmodSync(open, 0o777);
        await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: open }, log: quiet })).rejects.toThrow(/is open to other users \(mode 777\)\. Run `chmod 700/);
        expect(fs.readdirSync(open)).toEqual([]);
        // "/" belongs to root: another user's folder.
        if (process.getuid!() !== 0) await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: "/" }, log: quiet })).rejects.toThrow(/The lock folder \/ belongs to another user \(uid 0\)/);
        const file = path.join(tmp, "safe", "a-file");
        fs.writeFileSync(file, "");
        await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: file }, log: quiet })).rejects.toThrow(/is not a folder/);
        // lock-status says so too, instead of listing nothing.
        const status = await run(process.execPath, [path.join(root, "scripts", "lock-status.mjs")], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: link } }).done;
        expect(status.code).toBe(1);
        expect(status.out).toContain("is a symbolic link");
    });

    it("clears a lock whose holder is gone, or whose heartbeat stopped long ago, and leaves a live holder's lock alone", async () => {
        const dir = path.join(tmp, "stale");
        const env = { AITP_LOCK_DIR: dir };
        const said: string[] = [];
        fakeHolder(dir, "browser", { pid: await deadPid() });
        const r1 = (await acquireLock("browser", { env, pollMs: 50, timeoutMs: 5000, log: (s: string) => said.push(s) })) as Release;
        expect(said.join("\n")).toMatch(/cleared an abandoned lock left by pid \d+ \(an old run\)/);
        r1();
        // A running pid with a heartbeat older than STALE_MS (a reused pid, a hung holder): cleared only after the waiter has watched the
        // heartbeat stand still for CONFIRM_MS itself (here 300 ms), never at the first look.
        fakeHolder(dir, "browser", { pid: process.pid }, STALE_MS + 60_000);
        expect(holderOf("browser", env).stale).toBe(false);
        const t0 = Date.now();
        (await acquireLock("browser", { env, pollMs: 50, timeoutMs: 5000, confirmMs: 300, log: quiet }))();
        expect(Date.now() - t0).toBeGreaterThanOrEqual(300);
        expect(CONFIRM_MS).toBeGreaterThanOrEqual(30_000);
        fakeHolder(dir, "browser", { pid: process.pid });
        await expect(acquireLock("browser", { env, pollMs: 50, timeoutMs: 600, log: quiet })).rejects.toThrow(/Gave up/);
        expect(JSON.parse(fs.readFileSync(path.join(dir, "browser"), "utf8")).token).toBe("old-token");
        expect(fs.readdirSync(dir)).toEqual(["browser"]);
    });

    it("a live holder waking from a long sleep (heartbeat older than STALE_MS) keeps its lock: it touches it before a waiter is sure", async () => {
        const dir = path.join(tmp, "suspend");
        const env = { AITP_LOCK_DIR: dir };
        fakeHolder(dir, "browser", { pid: process.pid }, STALE_MS + 60_000);
        const lock = path.join(dir, "browser");
        // The holder's next heartbeat comes 150 ms into the wait, well before the waiter has watched it stand still for 600 ms.
        const wake = setTimeout(() => {
            const now = new Date();
            fs.utimesSync(lock, now, now);
        }, 150);
        try {
            await expect(acquireLock("browser", { env, pollMs: 20, timeoutMs: 1500, confirmMs: 600, log: quiet })).rejects.toThrow(/Gave up/);
        } finally {
            clearTimeout(wake);
        }
        expect(JSON.parse(fs.readFileSync(lock, "utf8")).token).toBe("old-token");
        fs.rmSync(lock);
    });

    it("a clearer's mark made afresh with a reused file number is not taken for a left one; a mark taken away under a clearer is no error", async () => {
        const dir = path.join(tmp, "mark-reuse");
        const lock = path.join(dir, "browser");
        const mark = `${lock}.reaping`;
        fakeHolder(dir, "browser", { pid: await deadPid() });
        fs.writeFileSync(mark, "first");
        const firstIno = fs.lstatSync(mark).ino;
        expect(reapAbandoned(lock, "old-token", quiet, 0)).toBe(false); // seen once
        // That clearer finished; another made a new mark which (as a file system may do) got the same file number.
        fs.rmSync(mark);
        await sleep(30);
        fs.writeFileSync(mark, "second");
        const realLstat = fs.lstatSync;
        const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: never) => {
            const st = realLstat(p, o);
            return String(p) === mark && st ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: firstIno }) : st;
        }) as never);
        const now = Date.now();
        const clock = vi.spyOn(Date, "now").mockReturnValue(now + MARK_LEFT_MS + 1000);
        try {
            expect(reapAbandoned(lock, "old-token", quiet, 0)).toBe(false);
        } finally {
            clock.mockRestore();
            lstat.mockRestore();
        }
        expect(fs.readFileSync(mark, "utf8")).toBe("second");
        fs.rmSync(mark);

        // The clearer's own mark is removed under it between its two steps: it leaves the lock alone and says nothing, no ENOENT thrown.
        const realStat = fs.statSync;
        let markStats = 0;
        const stat = vi.spyOn(fs, "statSync").mockImplementation(((p: fs.PathLike, o?: never) => {
            if (String(p) === mark && ++markStats === 2) throw Object.assign(new Error("ENOENT: gone"), { code: "ENOENT" });
            return realStat(p, o);
        }) as never);
        try {
            expect(reapAbandoned(lock, "old-token", quiet, 0)).toBe(false);
        } finally {
            stat.mockRestore();
        }
        expect(markStats).toBe(2);
        expect(JSON.parse(fs.readFileSync(lock, "utf8")).token).toBe("old-token");
        expect(reapAbandoned(lock, "old-token", quiet, 0)).toBe(true);
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("a lock folder that cannot hold hard links is a plain error at once, not a silent wait", async () => {
        const dir = path.join(tmp, "no-links");
        const realLink = fs.linkSync;
        const link = vi.spyOn(fs, "linkSync").mockImplementation(((a: fs.PathLike, b: fs.PathLike) => {
            if (String(b).startsWith(dir)) throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
            return realLink(a, b);
        }) as never);
        try {
            await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: dir }, pollMs: 20, timeoutMs: 3000, log: quiet })).rejects.toThrow(/does not allow hard links.*AITP_LOCK_DIR/);
        } finally {
            link.mockRestore();
        }
        expect(fs.readdirSync(dir)).toEqual([]); // no lock and no .new- file left
    });

    it("reads and clears a lock directory left by an older copy of the script, and waits for a live one", async () => {
        const dir = path.join(tmp, "legacy");
        const env = { AITP_LOCK_DIR: dir };
        const said: string[] = [];
        fakeHolder(dir, "browser", { pid: await deadPid() }, 0, true);
        (await acquireLock("browser", { env, pollMs: 50, timeoutMs: 5000, log: (s: string) => said.push(s) }))();
        expect(said.join("\n")).toMatch(/cleared an abandoned lock left by pid \d+ \(an old run\)/);
        fakeHolder(dir, "browser", { pid: process.pid, command: "an older checkout" }, 0, true);
        await expect(acquireLock("browser", { env, pollMs: 50, timeoutMs: 400, log: quiet })).rejects.toThrow(/held by pid \d+ \(an older checkout\)/);
        expect(fs.readdirSync(dir)).toEqual(["browser"]);
    });

    it("clearing an abandoned lock never moves or removes a lock taken afresh meanwhile, not even for a moment", async () => {
        // The race: B saw the lock abandoned (token "old-token"), A cleared it and C took it; now B goes on to clear what it saw.
        const dir = path.join(tmp, "reap-live");
        const env = { AITP_LOCK_DIR: dir };
        const c = (await acquireLock("browser", { env, log: quiet })) as Release;
        const lock = path.join(dir, "browser");
        const broken: string[] = [];
        const check = (op: string) => {
            const h = holderOf("browser", env);
            if (h?.owner?.token !== c.token) broken.push(`after ${op} the lock was ${h ? `held by ${h.owner?.token}` : "free"}`);
        };
        const spies = (["renameSync", "unlinkSync", "rmSync", "linkSync", "writeFileSync", "mkdirSync"] as const).map((m) => {
            const real = fs[m].bind(fs) as (...a: unknown[]) => unknown;
            return vi.spyOn(fs, m).mockImplementation(((...a: unknown[]) => {
                try {
                    return real(...a);
                } finally {
                    check(m);
                }
            }) as never);
        });
        try {
            expect(reapAbandoned(lock, "old-token", quiet)).toBe(false);
            // Even with C's own token (B misjudged a live holder as abandoned): a live, fresh lock is not cleared.
            expect(reapAbandoned(lock, c.token, quiet)).toBe(false);
        } finally {
            for (const s of spies) s.mockRestore();
        }
        expect(broken).toEqual([]);
        expect(holderOf("browser", env).owner.token).toBe(c.token);
        expect(fs.readdirSync(dir)).toEqual(["browser"]);
        c();
    });

    it("six racing waiters on an abandoned lock: exactly one holds it at a time, every one gets it, nothing is left behind", async () => {
        const dir = path.join(tmp, "race");
        const inside = path.join(tmp, "race-inside");
        const overlaps = path.join(tmp, "race-overlaps");
        const lockMod = JSON.stringify(path.join(root, "scripts", "lock.mjs"));
        const racer =
            `const m=await import(${lockMod});const fs=await import("node:fs");` +
            `const r=await m.acquireLock("race",{pollMs:2,timeoutMs:60000,log:()=>{}});` +
            `let mine=true;try{fs.writeFileSync(${JSON.stringify(inside)},String(process.pid),{flag:"wx"})}catch{mine=false;fs.appendFileSync(${JSON.stringify(overlaps)},process.pid+"\\n")}` +
            `await new Promise(s=>setTimeout(s,30));if(mine)fs.rmSync(${JSON.stringify(inside)},{force:true});r();process.stdout.write("held")`;
        for (let round = 0; round < 4; round++) {
            fakeHolder(dir, "race", { pid: await deadPid() });
            const all = Array.from({ length: 6 }, () => run(process.execPath, ["--input-type=module", "-e", racer], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "" } }).done);
            for (const r of await Promise.all(all)) {
                expect(r.code, r.out).toBe(0);
                expect(r.out).toBe("held");
            }
        }
        expect(fs.existsSync(overlaps) ? fs.readFileSync(overlaps, "utf8") : "").toBe("");
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it("a clearer that died between its two steps does not block clearing for good: its mark is removed after a few seconds", async () => {
        const dir = path.join(tmp, "left-mark");
        fakeHolder(dir, "browser", { pid: await deadPid() });
        fs.linkSync(path.join(dir, "browser"), path.join(dir, "browser.reaping"));
        const said: string[] = [];
        const t0 = Date.now();
        const r = (await acquireLock("browser", { env: { AITP_LOCK_DIR: dir }, pollMs: 50, timeoutMs: 20_000, log: (s: string) => said.push(s) })) as Release;
        expect(Date.now() - t0).toBeGreaterThanOrEqual(MARK_LEFT_MS);
        expect(said.join("\n")).toContain("removed browser.reaping, left by a run that died while clearing an abandoned lock");
        expect(said.join("\n")).toMatch(/cleared an abandoned lock left by pid \d+ \(an old run\)/);
        expect(holderOf("browser", { AITP_LOCK_DIR: dir }).owner.token).toBe(r.token);
        r();
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 30_000);

    it("is first come, first served: two runs taking it turn by turn do not starve a third waiter, which gets it after at most one turn", async () => {
        const dir = path.join(tmp, "fair");
        const log = path.join(tmp, "fair.log");
        const lockMod = JSON.stringify(path.join(root, "scripts", "lock.mjs"));
        // A run that takes the lock `turns` times, holding it 150 ms and asking again as soon as it gave it back (a test run, file by file).
        const taker = (who: string, turns: number) =>
            run(
                process.execPath,
                [
                    "--input-type=module",
                    "-e",
                    `const m=await import(${lockMod});const fs=await import("node:fs");const say=(s)=>fs.appendFileSync(${JSON.stringify(log)},s+"\\n");` +
                        `for(let i=0;i<${turns};i++){say("${who} asks");const r=await m.acquireLock("browser",{pollMs:20,log:()=>{}});say("${who} got");await new Promise((x)=>setTimeout(x,150));say("${who} free");r();}`,
                ],
                { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "" } },
            );
        const a = taker("A", 12);
        const b = taker("B", 12);
        await until(() => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter((l) => l.endsWith(" got")).length >= 4 : false), 15_000);
        const c = taker("C", 1);
        const results = await Promise.all([a.done, b.done, c.done]);
        for (const r of results) expect(r.code, r.out).toBe(0);
        const lines = fs.readFileSync(log, "utf8").trim().split("\n");
        const asked = lines.indexOf("C asks");
        const got = lines.indexOf("C got");
        const turnsBefore = lines.slice(asked, got).filter((l) => l.endsWith(" got"));
        expect(turnsBefore.length, lines.join("\n")).toBeLessThanOrEqual(1);
        // A and B alternate too, and the holders never overlap.
        const held = lines.filter((l) => l.endsWith(" got") || l.endsWith(" free"));
        for (let i = 0; i < held.length; i += 2) expect(held[i + 1], held.join("\n")).toBe(held[i].replace(" got", " free"));
        expect(fs.readdirSync(dir)).toEqual([]);
    }, 60_000);

    it("a queue ticket left by a run that is gone, or untouched for a minute (a stopped waiter), is cleared and does not block the queue", async () => {
        const dir = path.join(tmp, "fair-stale");
        const queue = path.join(dir, "browser.queue");
        ensureLockDir(dir);
        fs.mkdirSync(queue);
        const ticket = (name: string, pid: number, ageMs: number) => {
            const f = path.join(queue, name);
            fs.writeFileSync(f, JSON.stringify({ pid, host: os.hostname(), token: name, command: "a waiter", checkout: "/elsewhere", since: new Date().toISOString() }));
            const t = new Date(Date.now() - ageMs);
            fs.utimesSync(f, t, t);
        };
        ticket("00000000000000001-gone", await deadPid(), 0);
        ticket("00000000000000002-stopped", process.pid, TICKET_STALE_MS + 1000);
        const r = (await acquireLock("browser", { env: { AITP_LOCK_DIR: dir }, pollMs: 20, timeoutMs: 2000, log: quiet })) as Release;
        r();
        expect(fs.readdirSync(dir)).toEqual([]);
        // A live, fresh ticket ahead does block: the lock is free, yet this run waits its turn and gives up.
        fs.mkdirSync(queue);
        ticket("00000000000000003-waiting", process.pid, 0);
        await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: dir }, pollMs: 20, timeoutMs: 400, log: quiet })).rejects.toThrow(/1 run waits before this one/);
        expect(fs.readdirSync(queue)).toEqual(["00000000000000003-waiting"]);
        fs.rmSync(queue, { recursive: true });
    });

    it("waits 180 minutes by default (longer than the daily benchmark holds the lock), configurable; long waits read in hours", () => {
        expect(timeoutMs({})).toBe(180 * 60_000);
        expect(timeoutMs({ AITP_LOCK_TIMEOUT_MIN: "240" })).toBe(240 * 60_000);
        expect(timeoutMs({ AITP_LOCK_TIMEOUT_MIN: "" })).toBe(180 * 60_000);
        expect(ago(65 * 60_000)).toBe("65 min");
        expect(ago(125 * 60_000)).toBe("2 h 5 min");
    });

    it("refuses a wait time that is not a number of minutes above 0 with a plain error, instead of waiting forever", async () => {
        for (const bad of ["abc", "0", "-5", "Infinity", "3 hours"])
            expect(() => timeoutMs({ AITP_LOCK_TIMEOUT_MIN: bad })).toThrow(`AITP_LOCK_TIMEOUT_MIN must be a number of minutes above 0 (for example 240), not "${bad}".`);
        const dir = path.join(tmp, "bad-timeout");
        const held = (await acquireLock("browser", { env: { AITP_LOCK_DIR: dir }, log: quiet })) as Release;
        try {
            await expect(acquireLock("browser", { env: { AITP_LOCK_DIR: dir, AITP_LOCK_TIMEOUT_MIN: "abc" }, log: quiet })).rejects.toThrow(/AITP_LOCK_TIMEOUT_MIN must be/);
            await expect(acquireDist("read", { env: { AITP_LOCK_DIR: dir, AITP_LOCK_TIMEOUT_MIN: "abc" }, log: quiet })).rejects.toThrow(/AITP_LOCK_TIMEOUT_MIN must be/);
            const probe = [path.join(root, "scripts", "with-lock.mjs"), "browser", "--", process.execPath, "-e", "process.stdout.write('ran')"];
            const r = await Promise.race([
                run(process.execPath, probe, { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "", AITP_LOCK_TIMEOUT_MIN: "abc" } }).done,
                sleep(15_000).then(() => ({ code: -1, out: "still waiting after 15 s" })),
            ]);
            expect(r.code, r.out).toBe(3);
            expect(r.out).toContain('AITP_LOCK_TIMEOUT_MIN must be a number of minutes above 0 (for example 240), not "abc".');
            expect(r.out).not.toContain("ran");
        } finally {
            held();
        }
    }, 30_000);

    it("says how long a holder has held it, in the waiting line and in the error", async () => {
        const dir = path.join(tmp, "long-holder");
        fakeHolder(dir, "browser", { pid: process.pid, command: "node scripts/eval.mjs --bench", since: new Date(Date.now() - 70 * 60_000).toISOString() });
        const said: string[] = [];
        const e = await acquireLock("browser", { env: { AITP_LOCK_DIR: dir }, pollMs: 50, timeoutMs: 300, log: (x: string) => said.push(x) }).catch((x: Error) => x);
        expect(said[0]).toMatch(/^\[lock browser\] waiting for pid \d+ \(node scripts\/eval\.mjs --bench\) since .* \(held for 70 min\) in \/elsewhere$/);
        expect(String(e)).toMatch(/It is held by pid \d+ \(node scripts\/eval\.mjs --bench\) since .* \(held for 70 min\) in \/elsewhere/);
    });

    it("gives up after the longest wait with an error that names the holder and the way out", async () => {
        const env = { AITP_LOCK_DIR: locks, AITP_LOCK_TIMEOUT_MIN: "0.02" };
        const held = (await acquireLock("browser", { env, label: "vitest tests/long.test.ts", log: quiet })) as Release;
        try {
            const said: string[] = [];
            const t0 = Date.now();
            const e = await acquireLock("browser", { env, pollMs: 100, log: (s: string) => said.push(s) }).catch((x: Error) => x);
            expect(Date.now() - t0).toBeLessThan(5000);
            expect(String(e)).toContain(`Gave up waiting for the "browser" lock after 1 s. It is held by pid ${process.pid} (vitest tests/long.test.ts) since`);
            expect(String(e)).toContain(`in ${root}`);
            expect(String(e)).toContain("node scripts/lock-status.mjs");
            expect(String(e)).toContain("AITP_LOCK_TIMEOUT_MIN");
            expect(said[0]).toMatch(/^\[lock browser\] waiting for pid \d+ \(vitest tests\/long\.test\.ts\)/);
        } finally {
            held();
        }
    });

    it("build and browser are separate locks, taken in that order; a child of a holder re-enters only with the holder's token", async () => {
        const base = { AITP_LOCK_DIR: locks };
        const browser = (await acquireLock("browser", { env: base, log: quiet })) as Release;
        const inBrowser = { ...base, AITP_LOCK_HELD: heldWith("browser", browser.token, base) };
        try {
            expect(isHeld("browser", inBrowser)).toBe(true);
            expect(isHeld("browser", { ...base, AITP_LOCK_HELD: "browser:another-token" })).toBe(false);
            expect(isHeld("browser", { ...base, AITP_LOCK_HELD: "browser" })).toBe(false);
            // Someone else may build meanwhile: the build lock is free while browsers run.
            (await acquireLock("build", { env: base, timeoutMs: 500, log: quiet }))();
            // But a run holding "browser" may not wait for "build" (two such runs would wait for each other forever).
            await expect(acquireLock("build", { env: inBrowser, timeoutMs: 500, log: quiet })).rejects.toThrow(/holds the "browser" lock and now asks for "build".*Take both in one go, in order: node scripts\/with-lock\.mjs build,browser -- /);
        } finally {
            browser();
        }
        expect(isHeld("browser", inBrowser)).toBe(false); // released: the old token no longer re-enters
        const build = (await acquireLock("build", { env: base, log: quiet })) as Release;
        const inBuild = { ...base, AITP_LOCK_HELD: heldWith("build", build.token, base) };
        const both = (await acquireLock("browser", { env: inBuild, timeoutMs: 500, log: quiet })) as Release;
        expect(heldWith("browser", both.token, inBuild)).toBe(`build:${build.token},browser:${both.token}`);
        both();
        build();

        // with-lock: re-enters with the token, waits without it.
        const held = (await acquireLock("browser", { env: base, log: quiet })) as Release;
        try {
            const probe = [path.join(root, "scripts", "with-lock.mjs"), "browser", "--", process.execPath, "-e", "process.stdout.write('ran')"];
            const env = { ...cleanEnv(), AITP_LOCK_DIR: locks, AITP_LOCK_TIMEOUT_MIN: "0.03" };
            const inside = await run(process.execPath, probe, { cwd: tmp, env: { ...env, AITP_LOCK_HELD: heldWith("browser", held.token, {}) } }).done;
            expect(inside.code, inside.out).toBe(0);
            expect(inside.out).toBe("ran");
            const outside = await run(process.execPath, probe, { cwd: tmp, env: { ...env, AITP_LOCK_HELD: "browser:stale-token" } }).done;
            expect(outside.code).toBe(3);
            expect(outside.out).not.toContain("ran");
            expect(outside.out).toContain('Gave up waiting for the "browser" lock');
            const status = await run(process.execPath, [path.join(root, "scripts", "lock-status.mjs")], { cwd: tmp, env }).done;
            expect(status.out).toContain(`Locks in ${locks}:`);
            expect(status.out).toMatch(new RegExp(`browser +pid ${process.pid} \\(unnamed\\) since .* in .*; last heartbeat \\d+ s ago\\n`));
        } finally {
            held();
        }
    }, 30_000);
});

describe("with-lock with several locks", () => {
    it("takes them in order whatever order they are named in, passes both tokens on so inner takers re-enter, and gives both back", async () => {
        const env = { ...cleanEnv(), AITP_LOCK_DIR: locks, AITP_LOCK_HELD: "" };
        const lockMod = JSON.stringify(path.join(root, "scripts", "lock.mjs"));
        // The inner command asks for "build" as the vite build does (while "browser" is held): it re-enters instead of failing.
        const inner = `const m=await import(${lockMod});const held=process.env.AITP_LOCK_HELD;const r=await m.acquireLock("build",{timeoutMs:500}).catch(e=>e);` +
            `process.stdout.write(JSON.stringify({held,build:m.isHeld("build"),browser:m.isHeld("browser"),inner:r instanceof Error?r.message:"waited"}))`;
        const reenter = `const m=await import(${lockMod});process.stdout.write(JSON.stringify({held:process.env.AITP_LOCK_HELD,build:m.isHeld("build"),browser:m.isHeld("browser")}))`;
        const r = await run(process.execPath, [path.join(root, "scripts", "with-lock.mjs"), "browser,build", "--", process.execPath, "--input-type=module", "-e", reenter], { cwd: tmp, env }).done;
        expect(r.code, r.out).toBe(0);
        const got = JSON.parse(r.out);
        expect(got.held).toMatch(/^build:[\w-]+,browser:[\w-]+$/);
        expect(got).toMatchObject({ build: true, browser: true });
        expect(fs.readdirSync(locks).filter((n) => n === "build" || n === "browser")).toEqual([]);
        // Only "browser" held: an inner "build" request is refused with the fix in the message.
        const r2 = await run(process.execPath, [path.join(root, "scripts", "with-lock.mjs"), "browser", "--", process.execPath, "--input-type=module", "-e", inner], { cwd: tmp, env }).done;
        expect(JSON.parse(r2.out).inner).toContain("with-lock.mjs build,browser --");
    }, 30_000);
});

describe("with-lock stopped by a signal", () => {
    const withLock = path.join(root, "scripts", "with-lock.mjs");
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");

    it.skipIf(process.platform === "win32")("passes SIGTERM, SIGINT and SIGHUP on to the command and keeps the lock until the command has exited", async () => {
        for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
            const dir = path.join(tmp, `signal-${sig}`);
            const marks = path.join(tmp, `signal-${sig}.log`);
            const F = JSON.stringify(marks);
            // The command shuts down slowly (as vitest does while it closes its browsers).
            const code = `const fs=require("fs");process.on(${JSON.stringify(sig)},()=>{fs.appendFileSync(${F},"got\\n");setTimeout(()=>{fs.appendFileSync(${F},"bye\\n");process.exit(0)},1500)});fs.appendFileSync(${F},"ready\\n");setInterval(()=>{},1000)`;
            const w = run(process.execPath, [withLock, "browser", "--", process.execPath, "-e", code], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "" } });
            await until(() => read(marks).includes("ready"));
            w.child.kill(sig); // this script's pid only: the command hears of it from with-lock
            await until(() => read(marks).includes("got"));
            await sleep(700);
            expect(w.child.exitCode, `${sig}: ${w.output()}`).toBeNull();
            const h = holderOf("browser", { AITP_LOCK_DIR: dir });
            expect(h?.owner?.pid, sig).toBe(w.child.pid);
            expect(h.stale).toBe(false);
            const r = await w.done;
            expect(read(marks)).toBe("ready\ngot\nbye\n");
            expect(r.code, r.out).toBe(0);
            expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
        }
    }, 60_000);

    it.skipIf(process.platform === "win32")('in the `sh -c "a && b"` form, a signal reaches what the shell started, and the lock stays until it has exited', async () => {
        const dir = path.join(tmp, "signal-sh");
        const marks = path.join(tmp, "signal-sh.log");
        const F = JSON.stringify(marks);
        // `a && b`: the shell stays the command's process and the slow node process (as vitest closing its browsers) is its child.
        const inner = `const fs=require("fs");process.on("SIGTERM",()=>{fs.appendFileSync(${F},"got\\n");setTimeout(()=>{fs.appendFileSync(${F},"bye\\n");process.exit(0)},1500)});fs.appendFileSync(${F},"ready\\n");setInterval(()=>{},1000)`;
        const script = `"${process.execPath}" -e '${inner}' && echo after`;
        const s = run(process.execPath, [withLock, "browser", "--", "sh", "-c", script], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "" } });
        await until(() => read(marks).includes("ready"));
        s.child.kill("SIGTERM"); // the with-lock pid only, as CI cancelling or `kill <pid>` does
        await until(() => read(marks).includes("got"));
        await sleep(700);
        expect(read(marks)).not.toContain("bye");
        expect(holderOf("browser", { AITP_LOCK_DIR: dir })?.owner?.pid, s.output()).toBe(s.child.pid);
        await s.done;
        expect(read(marks)).toBe("ready\ngot\nbye\n");
        expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
    }, 30_000);

    it.skipIf(process.platform === "win32")("a command that exits leaving a process behind keeps the lock until that process is stopped", async () => {
        const dir = path.join(tmp, "signal-left");
        const marks = path.join(tmp, "signal-left.log");
        const F = JSON.stringify(marks);
        const inner = `const fs=require("fs");process.on("SIGTERM",()=>{fs.appendFileSync(${F},"stopped\\n");process.exit(0)});fs.appendFileSync(${F},"ready\\n");setInterval(()=>{},1000)`;
        const s = run(process.execPath, [withLock, "browser", "--", "sh", "-c", `"${process.execPath}" -e '${inner}' & echo started`], {
            cwd: tmp,
            env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "", AITP_WITH_LOCK_LINGER_MS: "800" },
        });
        await until(() => read(marks).includes("ready"));
        await sleep(300);
        expect(s.child.exitCode).toBeNull();
        expect(holderOf("browser", { AITP_LOCK_DIR: dir })?.owner?.pid).toBe(s.child.pid);
        const r = await s.done;
        expect(r.code, r.out).toBe(0);
        expect(r.out).toContain("processes it started are still running");
        expect(read(marks)).toBe("ready\nstopped\n");
        expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
    }, 30_000);

    it.skipIf(process.platform === "win32")("a second signal stops a command that does not exit, and only then gives the lock back", async () => {
        const dir = path.join(tmp, "signal-twice");
        const marks = path.join(tmp, "signal-twice.log");
        const code = `const fs=require("fs");process.on("SIGTERM",()=>fs.appendFileSync(${JSON.stringify(marks)},"ignored\\n"));fs.appendFileSync(${JSON.stringify(marks)},"ready\\n");setInterval(()=>{},1000)`;
        const w = run(process.execPath, [withLock, "browser", "--", process.execPath, "-e", code], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "" } });
        await until(() => read(marks).includes("ready"));
        w.child.kill("SIGTERM");
        await until(() => read(marks).includes("ignored"));
        await sleep(300);
        expect(holderOf("browser", { AITP_LOCK_DIR: dir })?.owner?.pid).toBe(w.child.pid);
        w.child.kill("SIGTERM");
        const r = await w.done;
        expect(r.code).toBe(128 + os.constants.signals.SIGKILL);
        expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
    }, 30_000);
});

describe("a holder whose lock was cleared while it was stopped", () => {
    const withLock = path.join(root, "scripts", "with-lock.mjs");
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    /** Put someone else's lock in place of `lock`, as a waiter does after clearing a lock whose heartbeat stood still. */
    const takenOver = (lock: string) => {
        fs.rmSync(lock, { force: true });
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: os.hostname(), token: "the-new-holder", command: "the next run", checkout: "/elsewhere", since: new Date().toISOString() }));
        const t = new Date(Date.now() - 5000);
        fs.utimesSync(lock, t, t);
        return fs.statSync(lock).mtimeMs;
    };

    it("notices at its next heartbeat, says so plainly, and never touches or removes the new holder's lock", async () => {
        const dir = path.join(tmp, "lost");
        const env = { AITP_LOCK_DIR: dir };
        const lost: string[] = [];
        const r = (await acquireLock("browser", { env, log: quiet, beatMs: 50, onLost: (m: string) => lost.push(m) })) as Release & { check: () => boolean };
        await sleep(200);
        expect(lost).toEqual([]);
        expect(r.check()).toBe(true);
        const beat = takenOver(path.join(dir, "browser"));
        await until(() => lost.length > 0, 3000);
        await sleep(200);
        expect(lost).toHaveLength(1);
        expect(lost[0]).toMatch(/\[lock browser\] this run's lock was cleared while the run was stopped or hung .*pid \d+ \(the next run\) .*holds it now\. Stopping here/);
        expect(r.check()).toBe(false);
        expect(fs.statSync(path.join(dir, "browser")).mtimeMs).toBe(beat);
        r();
        expect(holderOf("browser", env).owner.token).toBe("the-new-holder");
        fs.rmSync(path.join(dir, "browser"));
        // A dist reader (a browser-test file) whose mark was cleared notices the same way.
        const lostReader: string[] = [];
        const reader = (await acquireDist("read", { env, checkout: tmp, log: quiet, beatMs: 50, onLost: (m: string) => lostReader.push(m) })) as Release;
        for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("dist-"))) fs.rmSync(path.join(dir, f, "readers", reader.token), { force: true });
        await until(() => lostReader.length > 0, 3000);
        expect(lostReader[0]).toMatch(/\[lock dist\] this run's lock was cleared/);
        reader();
    });

    it.skipIf(process.platform === "win32")("with-lock stopped (SIGSTOP) past its lock: on resuming it stops the command and exits with an error, instead of running on", async () => {
        const dir = path.join(tmp, "lost-with-lock");
        const marks = path.join(tmp, "lost-with-lock.log");
        const F = JSON.stringify(marks);
        // A long command (20 s) that says when it is told to stop.
        const code = `const fs=require("fs");process.on("SIGTERM",()=>{fs.appendFileSync(${F},"stopped\\n");process.exit(0)});fs.appendFileSync(${F},"ready\\n");setTimeout(()=>{fs.appendFileSync(${F},"ran on\\n");process.exit(0)},20000)`;
        const w = run(process.execPath, [withLock, "browser", "--", process.execPath, "-e", code], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "", AITP_WITH_LOCK_BEAT_MS: "100" } });
        try {
            await until(() => read(marks).includes("ready"));
            w.child.kill("SIGSTOP");
            takenOver(path.join(dir, "browser"));
            await sleep(300);
            w.child.kill("SIGCONT");
            const r = await Promise.race([w.done, sleep(8000).then(() => undefined)]);
            expect(r, `still running: ${w.output()}`).toBeDefined();
            expect(r!.code, r!.out).toBe(4);
            expect(r!.out).toMatch(/this run's lock was cleared while the run was stopped or hung .*the next run.*Stopping here/s);
            expect(read(marks)).toBe("ready\nstopped\n");
            expect(holderOf("browser", { AITP_LOCK_DIR: dir }).owner.token).toBe("the-new-holder");
        } finally {
            w.child.kill("SIGKILL");
        }
    }, 30_000);
});

const hasPython = process.platform === "linux" && spawnSync("python3", ["--version"]).status === 0;

describe("with-lock on a terminal, and stopped by Ctrl+Z", () => {
    const withLock = path.join(root, "scripts", "with-lock.mjs");
    const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    const lines = (f: string) => read(f).split("\n").filter(Boolean).length;
    /** A command that writes a line every 100 ms to $OUT, 25 in all, then exits. */
    const ticker = () => {
        const f = path.join(tmp, "ticker.js");
        fs.writeFileSync(f, `const fs=require("fs");let n=0;setInterval(()=>{fs.appendFileSync(process.env.OUT,"t\\n");if(++n>=25)process.exit(0)},100);`);
        return f;
    };
    /** An interactive bash with job control on a pseudo-terminal (as a person's terminal): type() sends keys, output() is the screen. */
    function terminal(env: NodeJS.ProcessEnv) {
        const driver = path.join(tmp, "terminal.py");
        const py = [
            "import os, pty, select",
            "pid, fd = pty.fork()",
            "if pid == 0:",
            '    os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])',
            "while True:",
            "    r, _, _ = select.select([fd, 0], [], [])",
            "    if fd in r:",
            "        try:",
            "            data = os.read(fd, 4096)",
            "        except OSError:",
            "            break",
            "        if not data:",
            "            break",
            "        os.write(1, data)",
            "    if 0 in r:",
            "        data = os.read(0, 4096)",
            "        if not data:",
            "            break",
            "        os.write(fd, data)",
            "os.waitpid(pid, 0)",
            "",
        ];
        fs.writeFileSync(driver, py.join("\n"));
        const child = spawn("python3", ["-I", driver], { cwd: tmp, env, stdio: ["pipe", "pipe", "pipe"] });
        let out = "";
        child.stdout.on("data", (c) => (out += c));
        child.stderr.on("data", (c) => (out += c));
        return { child, type: (keys: string) => child.stdin.write(keys), output: () => out, close: () => child.kill("SIGKILL") };
    }

    it.skipIf(!hasPython)("keeps the command in the terminal's foreground job: it can set raw mode and read keys instead of being stopped by the terminal", async () => {
        const dir = path.join(tmp, "tty-raw");
        const out = path.join(tmp, "tty-raw.out");
        const cmd = path.join(tmp, "raw.js");
        // The process group of the command and of its parent (with-lock), then raw mode on and off: SIGTTOU stops a background group here.
        fs.writeFileSync(
            cmd,
            `const fs=require("fs");const pg=(p)=>fs.readFileSync("/proc/"+p+"/stat","utf8").split(") ")[1].split(" ")[2];` +
                `process.stdin.setRawMode(true);process.stdin.setRawMode(false);fs.writeFileSync(process.env.OUT,pg(process.pid)+" "+pg(process.ppid)+"\\n");process.exit(0)`,
        );
        const t = terminal({ ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "", OUT: out });
        try {
            t.type(`node ${JSON.stringify(withLock)} browser -- node ${JSON.stringify(cmd)}; echo "EXIT=$?"\n`);
            await until(() => /EXIT=\d+/.test(t.output()), 10_000);
            expect(t.output()).toMatch(/EXIT=0/);
            const [own, parent] = read(out).trim().split(" ");
            expect(own).toBe(parent);
            expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
        } finally {
            t.close();
        }
    }, 30_000);

    it.skipIf(!hasPython)("Ctrl+Z stops the command with with-lock, and fg goes on with both; the lock is kept throughout and given back at the end", async () => {
        const dir = path.join(tmp, "tty-stop");
        const out = path.join(tmp, "tty-stop.out");
        const t = terminal({ ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "", OUT: out });
        try {
            t.type(`node ${JSON.stringify(withLock)} browser -- node ${JSON.stringify(ticker())}\n`);
            await until(() => lines(out) >= 3, 10_000);
            t.type("\x1a");
            await until(() => /Stopped/.test(t.output()), 5000);
            await sleep(300);
            const at = lines(out);
            await sleep(800);
            expect(lines(out), "the command ran on while with-lock was stopped").toBe(at);
            expect(at).toBeLessThan(25);
            expect(holderOf("browser", { AITP_LOCK_DIR: dir })?.owner).toBeDefined();
            t.type('fg; echo "AFTER=$?"\n');
            await until(() => /AFTER=\d+/.test(t.output().split("Stopped")[1] ?? ""), 10_000);
            expect(t.output().split("Stopped")[1]).toMatch(/AFTER=0/);
            expect(lines(out)).toBe(25);
            expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
        } finally {
            t.close();
        }
    }, 30_000);

    it.skipIf(process.platform !== "linux")("not on a terminal, `kill -TSTP` of with-lock stops its whole command group, and `kill -CONT` continues it", async () => {
        const dir = path.join(tmp, "tstp");
        const out = path.join(tmp, "tstp.out");
        const w = run(process.execPath, [withLock, "browser", "--", "sh", "-c", `node ${JSON.stringify(ticker())} && echo done`], { cwd: tmp, env: { ...cleanEnv(), AITP_LOCK_DIR: dir, AITP_LOCK_HELD: "", OUT: out } });
        try {
            await until(() => lines(out) >= 3, 10_000);
            w.child.kill("SIGTSTP");
            await sleep(300);
            const at = lines(out);
            await sleep(800);
            expect(lines(out), "the command ran on while with-lock was stopped").toBe(at);
            expect(fs.readFileSync(`/proc/${w.child.pid}/stat`, "utf8").split(") ")[1][0]).toBe("T");
            w.child.kill("SIGCONT");
            const r = await w.done;
            expect(r.code, r.out).toBe(0);
            expect(r.out).toContain("done");
            expect(lines(out)).toBe(25);
            expect(holderOf("browser", { AITP_LOCK_DIR: dir })).toBeUndefined();
        } finally {
            w.child.kill("SIGKILL");
        }
    }, 30_000);
});

describe("browser starts", () => {
    it("are refused without the lock, with a plain sentence, before any browser starts", async () => {
        const restore = guardBrowserLaunch();
        try {
            process.env.AITP_LOCK_HELD = "";
            expect(isHeld("browser")).toBe(false);
            await expect(chromium.launch()).rejects.toThrow(UNLOCKED_LAUNCH_MESSAGE);
            await expect(chromium.launchPersistentContext(path.join(tmp, "profile"))).rejects.toThrow(UNLOCKED_LAUNCH_MESSAGE);
            await expect(chromium.launchServer()).rejects.toThrow(UNLOCKED_LAUNCH_MESSAGE);
            // A name without the holder's token (an old shell export) does not count as holding it.
            process.env.AITP_LOCK_HELD = "browser";
            await expect(chromium.launch()).rejects.toThrow(UNLOCKED_LAUNCH_MESSAGE);
            expect(fs.existsSync(path.join(tmp, "profile"))).toBe(false);
        } finally {
            process.env.AITP_LOCK_HELD = savedEnv.held ?? "";
            restore();
        }
    });
});

describe("a browser-tier test file run without with-lock", () => {
    // A throwaway vitest project inside the checkout (so it resolves vitest) whose one file is not in the fast tier, with the real setup.
    let dir: string;
    beforeAll(() => {
        fs.mkdirSync(path.join(root, ".scratch"), { recursive: true });
        dir = fs.mkdtempSync(path.join(root, ".scratch", "lock-unit-"));
        fs.writeFileSync(
            path.join(dir, "vitest.config.mjs"),
            `export default { test: { include: ["probe.test.ts"], setupFiles: [${JSON.stringify(path.join(root, "tests", "browser-lock.setup.ts"))}] } };\n`,
        );
        fs.writeFileSync(
            path.join(dir, "probe.test.ts"),
            [
                'import fs from "node:fs";',
                'import { test, expect } from "vitest";',
                'test("probe", () => {',
                '    expect(process.env.AITP_LOCK_HELD).toMatch(/^browser:[\\w-]+,dist:[\\w-]+$/);',
                `    fs.writeFileSync(${JSON.stringify(path.join(dir, "ran"))}, String(Date.now()));`,
                "});",
                "",
            ].join("\n"),
        );
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    const vitest = (held: string) =>
        run(process.execPath, [path.join(root, "node_modules", "vitest", "vitest.mjs"), "run", "--root", dir, "--config", path.join(dir, "vitest.config.mjs")], {
            cwd: dir,
            env: { ...cleanEnv(), AITP_LOCK_DIR: locks, AITP_LOCK_HELD: held, FORCE_COLOR: "0" },
        });

    it("waits while another run holds the lock, then runs holding it and gives it back", async () => {
        fs.rmSync(path.join(dir, "ran"), { force: true });
        const release = (await acquireLock("browser", { env: { AITP_LOCK_DIR: locks }, label: "another run", log: quiet })) as Release;
        const { child, done, output } = vitest("");
        await until(() => output().includes("[lock browser] waiting for pid"), 60_000);
        await sleep(2000);
        expect(fs.existsSync(path.join(dir, "ran"))).toBe(false);
        expect(child.exitCode).toBeNull();
        expect(output()).toContain(`(another run) since`);
        const releasedAt = Date.now();
        release();
        const r = await done;
        expect(r.code, r.out).toBe(0);
        expect(Number(fs.readFileSync(path.join(dir, "ran"), "utf8"))).toBeGreaterThanOrEqual(releasedAt);
        expect(fs.existsSync(path.join(locks, "browser"))).toBe(false);
    }, 90_000);

    it("runs straight away when its caller already holds the lock (with-lock, the test-tier runner)", async () => {
        fs.rmSync(path.join(dir, "ran"), { force: true });
        const release = (await acquireLock("browser", { env: { AITP_LOCK_DIR: locks }, log: quiet })) as Release;
        try {
            const r = await vitest(`browser:${release.token}`).done;
            expect(r.code, r.out).toBe(0);
            expect(fs.existsSync(path.join(dir, "ran"))).toBe(true);
        } finally {
            release();
        }
    }, 90_000);
});

describe("the web build", () => {
    it("waits for the build lock (not the browser lock) unless its caller holds it, and gives it back when the bundle is written", async () => {
        process.env.AITP_LOCK_DIR = locks;
        process.env.AITP_LOCK_HELD = "";
        const config = (await import(path.join(root, "web", "vite.config.ts"))).default as { plugins: { name: string; buildStart: () => Promise<void>; closeBundle: () => void }[] };
        const plugin = config.plugins.flat().find((p) => p?.name === "aitp-build-lock")!;
        expect(plugin).toBeTruthy();
        const browsers = (await acquireLock("browser", { env: { AITP_LOCK_DIR: locks }, log: quiet })) as Release;
        const other = (await acquireLock("build", { env: { AITP_LOCK_DIR: locks }, log: quiet })) as Release;
        let started = false;
        const p = plugin.buildStart().then(() => (started = true));
        await sleep(2500);
        expect(started).toBe(false);
        other();
        await p;
        expect(isHeld("build")).toBe(true);
        expect(fs.existsSync(path.join(locks, "build"))).toBe(true);
        plugin.closeBundle();
        expect(fs.existsSync(path.join(locks, "build"))).toBe(false);
        expect(isHeld("build")).toBe(false);
        expect(fs.existsSync(path.join(locks, "browser"))).toBe(true); // a browser run elsewhere never held the build up
        browsers();

        // A browser-test file of this checkout is reading web/dist: the build takes "build", then waits for it before writing.
        const said: string[] = [];
        const reader = (await acquireDist("read", { env: { AITP_LOCK_DIR: locks }, label: "vitest tests/ui-smoke.test.ts", log: quiet })) as Release;
        const errLog = console.error;
        console.error = (...a: unknown[]) => said.push(a.join(" "));
        try {
            started = false;
            const q = plugin.buildStart().then(() => (started = true));
            await until(() => said.some((l) => l.includes("[lock dist] web build waiting")));
            expect(isHeld("build")).toBe(true);
            expect(started).toBe(false);
            expect(said.join("\n")).toMatch(/1 browser-test run is using web\/dist of this checkout: pid \d+ \(vitest tests\/ui-smoke\.test\.ts\)/);
            reader();
            await q;
            expect(isHeld("dist")).toBe(true);
            plugin.closeBundle();
            expect(isHeld("build")).toBe(false);
            expect(lockStatus({ AITP_LOCK_DIR: locks }).dists).toEqual([]);
        } finally {
            console.error = errLog;
            reader();
        }
    }, 30_000);
});

describe("the long scripts", () => {
    // Scripted: nothing listens at these addresses (this file's ports), and each script is stopped or fails before it could reach one.
    const nowhere = { LLM_PROVIDER: "openai-compatible", LLM_BASE_URL: "http://127.0.0.1:9722/v1", LLM_API_KEY: "scripted", AITP_EVAL_URL: "" };

    it("scripts/eval.mjs (the bench) waits for the browser lock before it starts anything", async () => {
        const release = (await acquireLock("browser", { env: { AITP_LOCK_DIR: locks }, label: "another run", log: quiet })) as Release;
        const env = { ...cleanEnv(), ...nowhere, AITP_LOCK_DIR: locks, AITP_LOCK_HELD: "", DATA_DIR: path.join(tmp, "eval-data") };
        const { child, done, output } = run(process.execPath, [path.join(root, "scripts", "eval.mjs"), "--corpus", path.join(tmp, "no-such-corpus.json")], { cwd: tmp, env });
        await until(() => output().includes("[lock browser] waiting for pid"));
        await sleep(1000);
        expect(child.exitCode).toBeNull();
        expect(output()).not.toMatch(/corpus/i);
        release();
        const r = await done;
        expect(r.code, r.out).toBe(2); // then it runs: here it stops at the missing corpus, before any platform, browser or AI
        expect(r.out).toMatch(/no-such-corpus\.json/);
        expect(fs.existsSync(path.join(locks, "browser"))).toBe(false);
    }, 60_000);

    it("scripts/e2e.ts waits for the browser lock, then goes on", async () => {
        const release = (await acquireLock("browser", { env: { AITP_LOCK_DIR: locks }, label: "another run", log: quiet })) as Release;
        const scriptTmp = path.join(tmp, "e2e-tmp");
        fs.mkdirSync(scriptTmp);
        const env = { ...cleanEnv(), ...nowhere, AITP_LOCK_DIR: locks, AITP_LOCK_HELD: "", TMPDIR: scriptTmp, TMP: scriptTmp, TEMP: scriptTmp };
        const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
        const { child, done, output } = run(process.execPath, [tsx, path.join(root, "scripts", "e2e.ts"), "http://127.0.0.1:9723"], { cwd: root, env });
        try {
            await until(() => output().includes("[lock browser] waiting for pid"), 60_000);
            await sleep(1000);
            expect(child.exitCode).toBeNull();
            expect(output()).not.toContain("queued");
            release();
            await until(() => output().includes("queued for http://127.0.0.1:9723"), 60_000);
            expect(holderOf("browser", { AITP_LOCK_DIR: locks }).owner.command).toBe("scripts/e2e.ts http://127.0.0.1:9723"); // it holds it now
        } finally {
            release();
            child.kill("SIGTERM");
            await done;
        }
        // Stopped by a signal: whatever it left is an abandoned lock (its process is gone) that the next taker clears.
        const left = holderOf("browser", { AITP_LOCK_DIR: locks });
        expect(left === undefined || left.stale).toBe(true);
    }, 120_000);
});

describe("the web/dist guard of a checkout", () => {
    // Each test has its own lock folder, so one that fails leaves nothing behind for the next.
    let n = 0;
    let dir = "";
    beforeEach(() => {
        dir = path.join(tmp, `dist-locks-${++n}`);
    });
    const env = () => ({ AITP_LOCK_DIR: dir });
    const checkoutA = () => path.join(tmp, "dist-a");
    const checkoutB = () => path.join(tmp, "dist-b");

    it("lets many test files read at once; a build waits for them, says who they are, and goes ahead when they finish", async () => {
        const r1 = (await acquireDist("read", { env: env(), checkout: checkoutA(), label: "vitest tests/one.test.ts", log: quiet })) as Release;
        const r2 = (await acquireDist("read", { env: env(), checkout: checkoutA(), label: "vitest tests/two.test.ts", log: quiet, timeoutMs: 500 })) as Release;
        const said: string[] = [];
        let wrote: Release | undefined;
        const w = acquireDist("write", { env: env(), checkout: checkoutA(), label: "vite build web", pollMs: 50, log: (x: string) => said.push(x) }).then((r: Release) => (wrote = r));
        await until(() => said.length > 0);
        expect(said[0]).toMatch(/^\[lock dist\] web build waiting: 2 browser-test runs are using web\/dist of this checkout: pid \d+ \(vitest tests\/(one|two)\.test\.ts\) since .*; pid \d+ \(vitest tests\/(one|two)\.test\.ts\)/);
        expect(said[0]).toContain("one.test.ts");
        expect(said[0]).toContain("two.test.ts");
        // While the build waits, a new reader waits for it (no build waits forever behind a stream of test files).
        const late: string[] = [];
        let lateReader: Release | undefined;
        const lr = acquireDist("read", { env: env(), checkout: checkoutA(), label: "vitest tests/three.test.ts", pollMs: 50, log: (x: string) => late.push(x) }).then((r: Release) => (lateReader = r));
        await until(() => late.length > 0);
        expect(late[0]).toMatch(/^\[lock dist\] waiting for the web build of this checkout to finish: pid \d+ \(vite build web\)/);
        // A build of another checkout is not held up by this checkout's readers.
        (await acquireDist("write", { env: env(), checkout: checkoutB(), log: quiet, timeoutMs: 500 }))();
        r1();
        await sleep(300);
        expect(wrote).toBeUndefined();
        r2();
        await w;
        await sleep(300);
        expect(lateReader).toBeUndefined();
        const st = lockStatus(env()).dists;
        expect(st).toHaveLength(1);
        expect(st[0].checkout).toBe(checkoutA());
        expect(st[0].readers).toEqual([]);
        expect(st[0].writer.owner.command).toBe("vite build web");
        wrote!();
        await lr;
        lateReader!();
        expect(lockStatus(env()).dists).toEqual([]);
    });

    it("a build gives up after the longest wait naming the readers, and takes its mark back so readers go on", async () => {
        const r = (await acquireDist("read", { env: env(), checkout: checkoutA(), label: "vitest tests/slow-ui.test.ts", log: quiet })) as Release;
        try {
            const e = await acquireDist("write", { env: env(), checkout: checkoutA(), pollMs: 50, timeoutMs: 400, log: quiet }).catch((x: Error) => x);
            expect(String(e)).toMatch(new RegExp(`Gave up waiting for web/dist of ${checkoutA().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} after \\d+ s: 1 browser-test run is using web/dist of this checkout: pid ${process.pid} \\(vitest tests/slow-ui\\.test\\.ts\\)`));
            expect(String(e)).toContain("AITP_LOCK_TIMEOUT_MIN");
            (await acquireDist("read", { env: env(), checkout: checkoutA(), log: quiet, timeoutMs: 300 }))();
        } finally {
            r();
        }
        // A reader waiting for a build that never ends gives up the same way.
        const w = (await acquireDist("write", { env: env(), checkout: checkoutA(), label: "vite build web", log: quiet })) as Release;
        try {
            await expect(acquireDist("read", { env: env(), checkout: checkoutA(), pollMs: 50, timeoutMs: 300, log: quiet })).rejects.toThrow(/Gave up waiting for web\/dist of .*: a web build of this checkout is replacing it: pid \d+ \(vite build web\)/);
        } finally {
            w();
        }
    });

    it("clears a reader or a build whose process is gone", async () => {
        const dead = await deadPid();
        const said: string[] = [];
        const r = (await acquireDist("read", { env: env(), checkout: checkoutA(), log: quiet })) as Release;
        const base = lockStatus(env()).dists[0].base as string;
        r();
        fs.writeFileSync(path.join(base, "readers", "gone-reader"), JSON.stringify({ pid: dead, host: os.hostname(), token: "gone-reader", command: "vitest tests/crashed.test.ts", checkout: checkoutA(), since: new Date().toISOString() }));
        (await acquireDist("write", { env: env(), checkout: checkoutA(), pollMs: 50, timeoutMs: 2000, log: (x: string) => said.push(x) }))();
        expect(said.join("\n")).toMatch(/cleared an abandoned reader left by pid \d+ \(vitest tests\/crashed\.test\.ts\)/);
        fs.writeFileSync(path.join(base, "writer"), JSON.stringify({ pid: dead, host: os.hostname(), token: "gone-writer", command: "vite build web", checkout: checkoutA(), since: new Date().toISOString() }));
        (await acquireDist("read", { env: env(), checkout: checkoutA(), pollMs: 50, timeoutMs: 2000, log: (x: string) => said.push(x) }))();
        expect(said.join("\n")).toMatch(/cleared an abandoned web build left by pid \d+ \(vite build web\)/);
    });

    it("keeps the order build < browser < dist: holding the guard, asking for browser or build is refused; a build inside a reader re-enters", async () => {
        const e = env();
        const reader = (await acquireDist("read", { env: e, log: quiet })) as Release;
        const inReader = { ...e, AITP_LOCK_HELD: heldWith("dist", reader.token, {}) };
        try {
            expect(isHeld("dist", inReader)).toBe(true);
            await expect(acquireLock("browser", { env: inReader, timeoutMs: 300, log: quiet })).rejects.toThrow(/reads or builds web\/dist \(the "dist" guard\) and now asks for "browser"; take "browser" before the guard \(order: build < browser < dist\)/);
            await expect(acquireLock("build", { env: inReader, timeoutMs: 300, log: quiet })).rejects.toThrow(/now asks for "build"/);
            // A second reader in the same run goes straight on; a build the reader itself starts does not wait for its own caller.
            const again = (await acquireDist("read", { env: inReader, timeoutMs: 300, log: quiet })) as Release;
            expect(again.token).toBe(reader.token);
            const own = (await acquireDist("write", { env: inReader, timeoutMs: 300, log: quiet })) as Release;
            own();
        } finally {
            reader();
        }
        expect(isHeld("dist", inReader)).toBe(false);
        await expect(acquireLock("dist", { env: e, log: quiet })).rejects.toThrow(/acquireDist/);
    });

    it("no deadlock: a build (build, then dist) and a test run (browser, then dist) of one checkout both finish, either way round", async () => {
        const e = env();
        for (const testFirst of [true, false]) {
            const order: string[] = [];
            const testRun = async () => {
                const b = (await acquireLock("browser", { env: e, pollMs: 20, log: quiet })) as Release;
                const d = (await acquireDist("read", { env: { ...e, AITP_LOCK_HELD: heldWith("browser", b.token, {}) }, pollMs: 20, log: quiet })) as Release;
                order.push("test start");
                await sleep(300);
                order.push("test end");
                d();
                b();
            };
            const build = async () => {
                const b = (await acquireLock("build", { env: e, pollMs: 20, log: quiet })) as Release;
                const d = (await acquireDist("write", { env: { ...e, AITP_LOCK_HELD: heldWith("build", b.token, {}) }, pollMs: 20, log: quiet })) as Release;
                order.push("build start");
                await sleep(300);
                order.push("build end");
                d();
                b();
            };
            const [first, second] = testFirst ? [testRun, build] : [build, testRun];
            const p1 = first();
            await sleep(100);
            await Promise.race([Promise.all([p1, second()]), sleep(10_000).then(() => Promise.reject(new Error("deadlock")))]);
            expect(order).toEqual(testFirst ? ["test start", "test end", "build start", "build end"] : ["build start", "build end", "test start", "test end"]);
        }
    }, 30_000);
});

describe("the CI watch over the fast tier", () => {
    const watch = path.join(root, "scripts", "no-browser-watch.mjs");

    it.skipIf(process.platform === "win32")("fails the run when a browser process appears under it, naming it, and passes the command's own result otherwise", async () => {
        // A stand-in named like a browser (this Node.js under a browser's name, waiting a second): no real browser is started. It is one
        // process that starts no other: a shell script that ran `sleep` forked a copy of itself, still named like a browser until `sleep`
        // replaced it, and a busy machine sometimes showed that copy as a second browser process.
        const bin = path.join(tmp, "watch-bin");
        fs.mkdirSync(bin);
        fs.symlinkSync(process.execPath, path.join(bin, "chrome-headless-shell"));
        const env = { ...cleanEnv() };
        const caught = await run(process.execPath, [watch, "--", "sh", "-c", `${path.join(bin, "chrome-headless-shell")} -e 'setTimeout(() => {}, 1000)'; exit 0`], { cwd: tmp, env }).done;
        expect(caught.code, caught.out).toBe(1);
        expect(caught.out).toMatch(/\[no-browser-watch\] 1 browser process\(es\) started under a run that must start none:\n {2}pid \d+ \(parent \d+\): .*chrome-headless-shell/);
        const clean = await run(process.execPath, [watch, "--", "sh", "-c", "sleep 0.5; exit 0"], { cwd: tmp, env }).done;
        expect(clean.code, clean.out).toBe(0);
        expect(clean.out).toContain("no browser process started under the run");
        const failing = await run(process.execPath, [watch, "--", "sh", "-c", "exit 7"], { cwd: tmp, env }).done;
        expect(failing.code).toBe(7);
        expect((await run(process.execPath, [watch], { cwd: tmp, env }).done).code).toBe(2);
    }, 30_000);

    it.skipIf(process.platform === "win32")("fails when it could never read the process list (no ps, or ps always fails) instead of passing unseen", async () => {
        const failing = path.join(tmp, "ps-fails");
        fs.mkdirSync(failing);
        fs.writeFileSync(path.join(failing, "ps"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
        const missing = path.join(tmp, "ps-missing");
        fs.mkdirSync(missing);
        for (const bin of [failing, missing]) {
            const r = await run(process.execPath, [watch, "--", "/bin/sh", "-c", "sleep 0.5; exit 0"], { cwd: tmp, env: { ...cleanEnv(), PATH: bin } }).done;
            expect(r.code, r.out).toBe(2);
            expect(r.out).toContain("[no-browser-watch] could not read the process list (`ps`) even once, so it cannot say that no browser started");
            expect(r.out).not.toContain("no browser process started under the run");
        }
    }, 30_000);

    it("looks only at the run's own descendants, by executable name", () => {
        const all = new Map([
            [10, { ppid: 1, name: "node", args: "node runner" }],
            [11, { ppid: 10, name: "node", args: "node vitest tests/chrome-words.test.ts" }],
            [12, { ppid: 11, name: "headless_shell", args: "/x/headless_shell --headless" }],
            [13, { ppid: 1, name: "chrome", args: "/opt/google/chrome/chrome" }], // someone else's browser
            [14, { ppid: 11, name: "sh", args: "/x/firefox/firefox -headless" }],
        ]);
        expect((browsersUnder(10, all) as { pid: number }[]).map((b) => b.pid)).toEqual([12, 14]);
    });

    it("is the CI step that runs the fast tier, the lock tests have a CI step, and the fast config keeps the in-process launch refusal on", () => {
        const ci = fs.readFileSync(path.join(root, "..", ".github", "workflows", "ai-studio-ci.yml"), "utf8");
        expect(ci).toContain("run: node scripts/no-browser-watch.mjs -- npm run test:fast");
        // These lock tests run in CI too (a step of their own).
        expect(ci).toMatch(/- name: Lock tests\n\s+run: npx vitest run tests\/browser-lock-unit\.test\.ts\n/);
        const fast = fs.readFileSync(path.join(root, "vitest.fast.config.ts"), "utf8");
        expect(fast).toContain('setupFiles: ["tests/browser-lock.setup.ts"]');
        expect(fast).toContain('env: { AITP_LOCK_HELD: "" }');
    });
});
