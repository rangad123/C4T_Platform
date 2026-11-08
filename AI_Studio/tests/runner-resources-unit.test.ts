/**
 * What a run may take from a runner's computer (src/agent/resources.ts), and the runner never running one task twice at once.
 *
 * Real processes on this computer: the task's process at below-normal priority with a capped heap (and a process it starts inheriting the
 * priority), the memory of a process tree measured and a run over its limit stopped, the free-space check, the file cache brought within
 * its cap when the runner starts, and a task handed out again while its earlier run is still going here. Linux here; the memory watch and
 * the priority inheritance are POSIX checks (the Windows side is not run on this machine).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TaskOffer } from "../src/agent-protocol/schema.js";
import type { PlatformClient } from "../src/agent/client.js";
import { FileCache } from "../src/agent/file-cache.js";
import { memoryLogger } from "../src/agent/log.js";
import { DEFAULT_HEAP_MB, DEFAULT_MIN_FREE_MB, freeBytes, lowDiskRefusal, overMemory, resourceLimits, treeMemoryBytes, watchMemory } from "../src/agent/resources.js";
import { TaskProcess } from "../src/agent/task-process.js";
import { TaskRunner } from "../src/agent/task-runner.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-runner-resources-"));
const started: ChildProcess[] = [];
afterAll(() => {
    // Only the processes this file started, by their own pid (each leads its own process group).
    for (const c of started) {
        try {
            if (c.pid && c.exitCode === null) process.kill(-c.pid, "SIGKILL");
        } catch {
            /* already gone */
        }
    }
    fs.rmSync(root, { recursive: true, force: true });
});

describe("the limits a runner reads from its environment", () => {
    it("defaults: below-normal priority, a 2048 MB heap, no memory watch, 512 MB kept free; each can be changed or switched off", () => {
        expect(resourceLimits({})).toEqual({ priority: os.constants.priority.PRIORITY_BELOW_NORMAL, heapMb: DEFAULT_HEAP_MB, memoryMb: 0, minFreeMb: DEFAULT_MIN_FREE_MB });
        expect(resourceLimits({ AITP_AGENT_TEST_PRIORITY: "normal", AITP_AGENT_TEST_HEAP_MB: "0", AITP_AGENT_TEST_MEMORY_MB: "3000", AITP_AGENT_MIN_FREE_MB: "0" })).toEqual({ heapMb: 0, memoryMb: 3000, minFreeMb: 0 });
        expect(resourceLimits({ AITP_AGENT_TEST_PRIORITY: "low" }).priority).toBe(os.constants.priority.PRIORITY_LOW);
        // Out of range is brought in range; nonsense keeps the default.
        expect(resourceLimits({ AITP_AGENT_TEST_HEAP_MB: "10" }).heapMb).toBe(256);
        expect(resourceLimits({ AITP_AGENT_TEST_HEAP_MB: "lots", AITP_AGENT_MIN_FREE_MB: "-5" })).toMatchObject({ heapMb: DEFAULT_HEAP_MB, minFreeMb: DEFAULT_MIN_FREE_MB });
    });
});

describe("the task's process", () => {
    it("runs at below-normal priority with its heap capped; a process it starts inherits the priority; the test runner is told the cap", async () => {
        const entry = path.join(root, "child.mjs");
        fs.writeFileSync(
            entry,
            [
                'import os from "node:os";',
                'import v8 from "node:v8";',
                'import { execFileSync } from "node:child_process";',
                "process.on(\"message\", () => {",
                '    const grand = Number(execFileSync(process.execPath, ["-e", "process.stdout.write(String(require(\'os\').getPriority()))"]).toString());',
                '    process.send({ type: "log", line: JSON.stringify({ prio: os.getPriority(), grand, heapMb: Math.round(v8.getHeapStatistics().heap_size_limit / 1048576), env: process.env.AITP_TEST_HEAP_MB ?? null }) });',
                '    process.send({ type: "result", runs: [] }, () => process.exit(0));',
                "});",
            ].join("\n"),
        );
        const lines: string[] = [];
        const proc = new TaskProcess({ PATH: process.env.PATH }, (l) => lines.push(l), entry, { priority: os.constants.priority.PRIORITY_BELOW_NORMAL, heapMb: 300 });
        expect(proc.priorityLowered).toBe(true);
        proc.start({ type: "run" } as never);
        expect((await proc.done).kind).toBe("result");
        const seen = JSON.parse(lines[0]!) as { prio: number; grand: number; heapMb: number; env: string | null };
        if (process.platform !== "win32") {
            expect(seen.prio).toBe(10);
            expect(seen.grand).toBe(10);
        }
        // heap_size_limit is the old space plus the young generation, which differs by Node.js version (about 330 MB on Node 22, about 490 MB on
        // Node 24 for a 300 MB cap), so the check is that the cap applies, not an exact figure: at least the cap, and well under Node's own limit.
        expect(seen.heapMb).toBeGreaterThanOrEqual(300);
        expect(seen.heapMb).toBeLessThan(800);
        expect(seen.env).toBe("300");

        // Switched off: normal priority, Node's own heap limit, nothing handed on.
        const plain: string[] = [];
        const normal = new TaskProcess({ PATH: process.env.PATH }, (l) => plain.push(l), entry, { heapMb: 0 });
        expect(normal.priorityLowered).toBe(false);
        normal.start({ type: "run" } as never);
        await normal.done;
        const p = JSON.parse(plain[0]!) as { prio: number; env: string | null; heapMb: number };
        expect(p.env).toBeNull();
        // Without the cap the limit is Node's own, larger than the capped one.
        expect(p.heapMb).toBeGreaterThan(seen.heapMb);
        expect(p.prio).toBe(os.getPriority());
    }, 30_000);
});

describe.skipIf(process.platform === "win32")("the memory of a run's process tree", () => {
    const hog = (mb: number) => `const b = Buffer.alloc(${mb} * 1024 * 1024, 1); setInterval(() => b[0]++, 1000);`;

    it("is measured with what its processes started, and a tree over its limit is reported once", async () => {
        const parent = spawn(process.execPath, ["-e", `require("child_process").spawn(process.execPath, ["-e", ${JSON.stringify(hog(160))}], { stdio: "ignore" }); setInterval(() => {}, 1000);`], { stdio: "ignore", detached: true });
        started.push(parent);
        let tree = 0;
        for (let i = 0; i < 50 && tree < 160 * 1024 * 1024; i++) {
            await new Promise((r) => setTimeout(r, 100));
            tree = (await treeMemoryBytes(parent.pid!)) ?? 0;
        }
        expect(tree).toBeGreaterThan(160 * 1024 * 1024);
        const over: number[] = [];
        const stop = watchMemory(parent.pid, 100, (used) => over.push(used), 100);
        for (let i = 0; i < 50 && over.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
        await new Promise((r) => setTimeout(r, 400));
        stop();
        expect(over).toHaveLength(1);
        expect(overMemory(100, over[0]!)).toMatch(/^The run used \d+ MB of memory, more than the 100 MB this runner allows \(AITP_AGENT_TEST_MEMORY_MB\), and was stopped\.$/);
        // Under the limit, or no limit: nothing is reported.
        const quiet: number[] = [];
        const stopQuiet = watchMemory(parent.pid, 4096, (u) => quiet.push(u), 100);
        const stopOff = watchMemory(parent.pid, 0, (u) => quiet.push(u), 100);
        await new Promise((r) => setTimeout(r, 500));
        stopQuiet();
        stopOff();
        expect(quiet).toEqual([]);
        expect(await treeMemoryBytes(2 ** 22 + 12345)).toBeUndefined();
    }, 30_000);
});

describe("free disk space", () => {
    it("is read from the system, and a run is turned down below the mark with a plain sentence", async () => {
        expect(await freeBytes(root)).toBeGreaterThan(0);
        expect(await freeBytes(path.join(root, "no-such-folder"))).toBeUndefined();
        const tight = await lowDiskRefusal(root, 512, async () => 300 * 1024 * 1024);
        expect(tight).toBe("This computer has only 300 MB of free disk space where the runner works, and the runner keeps at least 512 MB free (AITP_AGENT_MIN_FREE_MB), so it did not take the run. Free some space, then run again.");
        expect(await lowDiskRefusal(root, 512, async () => 600 * 1024 * 1024)).toBeUndefined();
        expect(await lowDiskRefusal(root, 0, async () => 0)).toBeUndefined();
        expect(await lowDiskRefusal(root, 512, async () => undefined)).toBeUndefined();
    });

    it("protocol 2 turns the task down, protocol 1 answers ok=false; nothing is downloaded or started", async () => {
        for (const protocol of [2, 1]) {
            const calls: Array<{ kind: string; body: any }> = [];
            const client = {
                reject: async (_id: string, body: unknown) => void calls.push({ kind: "reject", body }),
                result: async (_id: string, body: unknown) => (calls.push({ kind: "result", body }), { alreadyReceived: false }),
                download: async () => {
                    calls.push({ kind: "download", body: null });
                    throw new Error("not expected");
                },
            } as unknown as PlatformClient;
            const { log } = memoryLogger();
            // A mark no disk reaches: every run is turned down.
            const runner = new TaskRunner({ client, cache: {} as never, log, workDir: root, hello: { agentId: "a", projectId: "p", protocol, pollSeconds: 1, heartbeatSeconds: 1, maxFileBytes: 1000, serverTime: "now" }, probe: { get: async () => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"] }) } as never, env: { AITP_AGENT_MIN_FREE_MB: "1048576" } });
            await runner.run(TaskOffer.parse({ taskId: `task-disk-${protocol}-0001`, jobId: "job-1", adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "x" }], env: { baseUrl: "https://shop.example.test", headless: true }, ...(protocol === 2 ? { attemptId: "attempt-disk-1", attempt: 1, acceptSeconds: 30 } : {}) }));
            expect(calls).toHaveLength(1);
            if (protocol === 2) expect(calls[0]).toEqual({ kind: "reject", body: expect.objectContaining({ attemptId: "attempt-disk-1", reason: "other", message: expect.stringMatching(/free disk space/) }) });
            else expect(calls[0]).toEqual({ kind: "result", body: expect.objectContaining({ ok: false, error: expect.stringMatching(/free disk space/) }) });
        }
    });
});

describe("the file cache", () => {
    it("is brought within its cap when the runner starts, oldest first, and half-finished downloads are removed", async () => {
        const dir = path.join(root, "cache");
        fs.mkdirSync(dir, { recursive: true });
        const names = ["a", "b", "c"].map((c) => `${c.repeat(64)}.png`);
        names.forEach((n, i) => {
            const f = path.join(dir, n);
            fs.writeFileSync(f, Buffer.alloc(1024 * 1024, i));
            const t = new Date(Date.now() - (3 - i) * 60_000);
            fs.utimesSync(f, t, t);
        });
        fs.writeFileSync(path.join(dir, ".tmp-leftover"), "x");
        await new FileCache(dir, 1.5 * 1024 * 1024).init();
        expect(fs.readdirSync(dir).sort()).toEqual([names[2]]);
    });
});

describe("a task handed out again while it still runs here", () => {
    it("stops the earlier run without a result before the new one starts: never two at once, one result", async () => {
        const calls: Array<{ kind: string; body: any }> = [];
        let downloads = 0;
        let atOnce = 0;
        let mostAtOnce = 0;
        const client = {
            heartbeat: async () => ({ cancel: false, leaseSeconds: 60 }),
            result: async (_id: string, body: unknown) => (calls.push({ kind: "result", body }), { alreadyReceived: false }),
            // The first run waits in its download until it is stopped; the second one fails at once (a plain "could not run").
            download: async (_t: string, _r: unknown, _d: string, signal: AbortSignal) => {
                const n = ++downloads;
                atOnce++;
                mostAtOnce = Math.max(mostAtOnce, atOnce);
                try {
                    if (n === 1) await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }));
                    throw new Error("The file is gone.");
                } finally {
                    atOnce--;
                }
            },
        } as unknown as PlatformClient;
        const { log } = memoryLogger();
        const work = path.join(root, "work");
        const cache = new FileCache(path.join(work, "cache"), 10 * 1024 * 1024);
        await cache.init();
        const runner = new TaskRunner({ client, cache, log, workDir: work, heartbeatMs: 50, hello: { agentId: "a", projectId: "p", protocol: 1, pollSeconds: 1, heartbeatSeconds: 1, maxFileBytes: 1000, serverTime: "now" }, probe: { get: async () => ({ os: "linux", arch: "x64", node: "v24.0.0", browsers: ["chromium"] }) } as never, env: { AITP_AGENT_MIN_FREE_MB: "0" } });
        const offer = TaskOffer.parse({ taskId: "task-again-000001", jobId: "job-1", adapterId: "playwright", leaseSeconds: 60, workers: 1, scripts: [{ testId: "t1", filename: "t1.spec.ts", content: "x", baselines: [{ name: "home.png", file: { ref: "b0-aaaa.png", size: 10, sha256: "a".repeat(64) } }] }], env: { baseUrl: "https://shop.example.test", headless: true } });
        const first = runner.run(offer);
        for (let i = 0; i < 50 && downloads === 0; i++) await new Promise((r) => setTimeout(r, 20));
        expect(downloads).toBe(1);
        await runner.run(offer);
        await first;
        expect(downloads).toBe(2);
        expect(mostAtOnce).toBe(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.body).toMatchObject({ ok: false, error: expect.stringMatching(/could not run this task: The file is gone/) });
        expect(runner.active.size).toBe(0);
        expect(fs.readdirSync(path.join(work, "tasks")).length).toBe(0);
    }, 30_000);
});
