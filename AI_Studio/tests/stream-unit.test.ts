/**
 * Live event streaming, the parts that need no server: SSE framing, resume ids, backoff, caps, stream tickets, the in-process bell,
 * the database queries, and the tailing loop driven by a fake clock (ordering, paging, resume, no duplicates, end, heartbeat, slow client,
 * nothing left running). Browser-free; part of the fast tier.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { EventBus, eventBus, ANY_JOB } from "../src/platform/event-bus.js";
import { DEFAULT_JOB_OPTIONS } from "../src/platform/repo.js";
import { nextDelay, parseLastEventId, redactStreamUrl, sseFrame, streamConfig, StreamCaps, TailLoop, TicketStore, type SnapshotRead, type StopReason, type StreamConfig, type StreamEvent } from "../src/platform/stream-core.js";
import { jobEventsAfter, projectEventsAfter, projectHead, recentJobStates, recentWindow } from "../src/platform/stream-store.js";

const cfg = (over: Partial<StreamConfig> = {}): StreamConfig => ({ ...streamConfig({}), ...over });

describe("SSE framing", () => {
    it("writes event, id and data lines and ends the frame with a blank line", () => {
        expect(sseFrame({ event: "log", id: 12, data: { a: 1 } })).toBe('event: log\nid: 12\ndata: {"a":1}\n\n');
    });
    it("writes a comment and a retry hint", () => {
        expect(sseFrame({ comment: "keep-alive" })).toBe(": keep-alive\n\n");
        expect(sseFrame({ retry: 3000 })).toBe("retry: 3000\n\n");
    });
    it("a snapshot has no id, so it cannot move the resume position", () => {
        expect(sseFrame({ event: "job", data: { status: "QUEUED" } })).not.toContain("id:");
    });
    it("newlines inside a field never start another field", () => {
        const f = sseFrame({ event: "log\nid: 99", id: 5, data: "line one\nid: 7\r\nevent: end" });
        expect(f.split("\n").filter((l) => l.startsWith("id:"))).toEqual(["id: 5"]);
        expect(f.split("\n").filter((l) => l.startsWith("event:"))).toEqual(["event: log id: 99"]);
        expect(f.split("\n").filter((l) => l.startsWith("data:"))).toEqual(["data: line one", "data: id: 7", "data: event: end"]);
    });
    it("JSON data stays on one line even when a message holds a newline", () => {
        const f = sseFrame({ event: "log", id: 1, data: { message: "a\nb" } });
        expect(f.split("\n").filter((l) => l.startsWith("data:"))).toHaveLength(1);
    });
});

describe("resume position", () => {
    it("takes the Last-Event-ID header first, then the query value", () => {
        expect(parseLastEventId("42", "7")).toBe(42);
        expect(parseLastEventId(undefined, "7")).toBe(7);
        expect(parseLastEventId(["9"], undefined)).toBe(9);
    });
    it("ignores anything that is not a plain non-negative whole number", () => {
        for (const bad of ["", "-1", "1.5", "abc", "1e3", "12 13", "9".repeat(20), undefined, null, 5]) expect(parseLastEventId(bad as never)).toBeUndefined();
        expect(parseLastEventId("junk", "11")).toBe(11);
        expect(parseLastEventId("0")).toBe(0);
    });
});

describe("pace of the tailing loop", () => {
    it("is short while events flow and grows, with a ceiling, while quiet", () => {
        const c = { pollMs: 250, maxPollMs: 1000 };
        expect(nextDelay(250, true, c)).toBe(250);
        const seq: number[] = [];
        let d = 250;
        for (let i = 0; i < 6; i++) seq.push((d = nextDelay(d, false, c)));
        expect(seq).toEqual([375, 563, 845, 1000, 1000, 1000]);
        expect(nextDelay(1000, true, c)).toBe(250);
    });
    it("never goes below the base", () => {
        expect(nextDelay(1, false, { pollMs: 250, maxPollMs: 1000 })).toBe(250);
    });
});

describe("caps", () => {
    it("refuses past the global and the per-key limit and counts back down on release", () => {
        const caps = new StreamCaps(3, 2);
        const a1 = caps.acquire("job:a")!;
        const a2 = caps.acquire("job:a")!;
        expect(caps.acquire("job:a")).toBeUndefined();
        const b1 = caps.acquire("job:b")!;
        expect(caps.acquire("job:c")).toBeUndefined();
        expect(caps.open).toBe(3);
        a1();
        a1(); // a second release changes nothing
        expect(caps.open).toBe(2);
        expect(caps.openFor("job:a")).toBe(1);
        const c1 = caps.acquire("job:c");
        expect(c1).toBeTypeOf("function");
        for (const r of [a2, b1, c1!]) r();
        expect(caps.open).toBe(0);
        expect(caps.openFor("job:a")).toBe(0);
    });
});

describe("stream tickets", () => {
    const P = "/api/test-generation/abc/stream";
    it("opens exactly one stream, once", () => {
        const t = new TicketStore(60_000, 10);
        const ticket = t.issue(P)!;
        expect(ticket).toMatch(/^st_[A-Za-z0-9_-]{32}$/);
        expect(t.consume(ticket, P)).toBe("ok");
        expect(t.consume(ticket, P)).toBe("invalid");
    });
    it("is refused for another path, and is then spent", () => {
        const t = new TicketStore(60_000, 10);
        const ticket = t.issue(P)!;
        expect(t.consume(ticket, "/api/test-generation/other/stream")).toBe("invalid");
        expect(t.consume(ticket, P)).toBe("invalid");
    });
    it("expires after its lifetime", () => {
        let now = 1_000;
        const t = new TicketStore(60_000, 10, () => now);
        const live = t.issue(P)!;
        const late = t.issue(P)!;
        now += 59_999;
        expect(t.consume(live, P)).toBe("ok");
        now += 2;
        expect(t.consume(late, P)).toBe("invalid");
        expect(t.size).toBe(0);
    });
    it("refuses a made-up or empty ticket", () => {
        const t = new TicketStore(60_000, 10);
        expect(t.consume("st_nothing", P)).toBe("invalid");
        expect(t.consume("", P)).toBe("invalid");
    });
    it("limits the tickets waiting to be used, and frees room as they expire", () => {
        let now = 0;
        const t = new TicketStore(1_000, 2, () => now);
        expect(t.issue(P)).toBeTruthy();
        expect(t.issue(P)).toBeTruthy();
        expect(t.issue(P)).toBeUndefined();
        now += 1_001;
        expect(t.issue(P)).toBeTruthy();
    });
    it("every ticket is different", () => {
        const t = new TicketStore(60_000, 100);
        const all = new Set(Array.from({ length: 50 }, () => t.issue(P)));
        expect(all.size).toBe(50);
    });
});

describe("address redaction", () => {
    it("hides a ticket or key in a query string and leaves the rest", () => {
        expect(redactStreamUrl("/api/projects/p1/stream?ticket=st_abc123&lastEventId=4")).toBe("/api/projects/p1/stream?ticket=[hidden]&lastEventId=4");
        expect(redactStreamUrl("/api/artifacts/x?key=secretvalue")).toBe("/api/artifacts/x?key=[hidden]");
        expect(redactStreamUrl("/api/projects?a=1&Ticket=zzz")).toBe("/api/projects?a=1&Ticket=[hidden]");
        expect(redactStreamUrl("/api/health")).toBe("/api/health");
    });
});

describe("the in-process bell", () => {
    it("wakes listeners of a job and of all jobs, and nobody else", () => {
        const bus = new EventBus();
        const hits: string[] = [];
        bus.subscribe("j1", () => hits.push("j1"));
        bus.subscribe("j2", () => hits.push("j2"));
        bus.subscribe(ANY_JOB, () => hits.push("any"));
        bus.publish("j1");
        expect(hits.sort()).toEqual(["any", "j1"]);
    });
    it("a subscription is removed once and counts back down; a throwing listener does not stop the others", () => {
        const bus = new EventBus();
        let reached = false;
        const off1 = bus.subscribe("j", () => {
            throw new Error("boom");
        });
        const off2 = bus.subscribe("j", () => (reached = true));
        expect(bus.listenerCount()).toBe(2);
        expect(() => bus.publish("j")).not.toThrow();
        expect(reached).toBe(true);
        off1();
        off1();
        off2();
        expect(bus.listenerCount()).toBe(0);
    });
});

describe("queries and the bell on a real database", () => {
    let platform: Platform;
    let dataDir: string;
    let projectId: string;
    let otherProject: string;
    let jobA: string;
    let jobB: string;
    let jobOther: string;
    const job = async (pid: string) => (await platform.repo.createJob(pid, platform.repo.createApplication(pid, "http://127.0.0.1:1", { ...DEFAULT_JOB_OPTIONS }, undefined), { ...DEFAULT_JOB_OPTIONS, mode: "validate", testIds: [] })).id;
    const ev = (jobId: string, n: number, level: "info" | "warn" = "info") => platform.repo.addEvent(jobId, { stage: "validation", kind: "k", level, message: `m${n}` });

    beforeAll(async () => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-stream-unit-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, LLM_PROVIDER: "anthropic" }));
        projectId = platform.repo.createProject({ name: "S1" }).id;
        otherProject = platform.repo.createProject({ name: "S2" }).id;
        jobA = await job(projectId);
        platform.repo.setJobStatus(jobA, "FAILED", "done");
        jobB = await job(projectId);
        jobOther = await job(otherProject);
    });
    afterAll(() => {
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("events come back after an id, in id order, for one job only", () => {
        for (let i = 1; i <= 5; i++) {
            ev(jobA, i);
            ev(jobOther, i);
        }
        const all = jobEventsAfter(platform.db, jobA, 0, 100);
        expect(all.map((e) => e.message)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
        expect(all.every((e) => e.jobId === jobA)).toBe(true);
        const ids = all.map((e) => e.id);
        expect(ids).toEqual([...ids].sort((a, b) => a - b));
        expect(jobEventsAfter(platform.db, jobA, ids[2]!, 100).map((e) => e.message)).toEqual(["m4", "m5"]);
        expect(jobEventsAfter(platform.db, jobA, 0, 2)).toHaveLength(2);
        expect(jobEventsAfter(platform.db, jobA, ids[4]!, 100)).toEqual([]);
        expect(Object.keys(all[0]!).sort()).toEqual(["at", "id", "jobId", "kind", "level", "message", "stage"]);
    });

    it("a project sees the events of its jobs and not another project's", () => {
        ev(jobB, 1);
        const mine = projectEventsAfter(platform.db, projectId, 0, 100);
        expect(new Set(mine.map((e) => e.jobId))).toEqual(new Set([jobA, jobB]));
        expect(mine.some((e) => e.jobId === jobOther)).toBe(false);
        const head = projectHead(platform.db, projectId);
        expect(head).toBe(Math.max(...mine.map((e) => e.id)));
        expect(projectEventsAfter(platform.db, projectId, head, 10)).toEqual([]);
        expect(projectHead(platform.db, "nobody")).toBe(0);
    });

    it("a new connection starts at the most recent events and says how many older ones exist", () => {
        expect(recentWindow(platform.db, jobA, 500)).toEqual({ after: 0, earlier: 0 });
        const w = recentWindow(platform.db, jobA, 2);
        expect(w.earlier).toBe(3);
        expect(jobEventsAfter(platform.db, jobA, w.after, 100).map((e) => e.message)).toEqual(["m4", "m5"]);
        expect(recentWindow(platform.db, jobA, 5)).toEqual({ after: 0, earlier: 0 });
    });

    it("lists a project's recent jobs newest first, with the status", () => {
        const s = recentJobStates(platform.db, projectId, 20);
        expect(s.map((x) => x.id)).toEqual([jobB, jobA]);
        expect(s.find((x) => x.id === jobA)!.status).toBe("FAILED");
    });

    it("writing an event, a phase, counters or a status rings the bell for that job", () => {
        const rung: string[] = [];
        const off = eventBus.subscribe(jobB, () => rung.push("b"));
        const offOther = eventBus.subscribe(jobOther, () => rung.push("other"));
        ev(jobB, 2);
        platform.repo.setPhase(jobB, "validation", "running");
        platform.repo.updateCounters(jobB, { testsValidated: 1 });
        platform.repo.setJobStatus(jobB, "VALIDATING");
        expect(rung).toEqual(["b", "b", "b", "b"]);
        off();
        offOther();
        expect(eventBus.listenerCount()).toBe(0);
    });
});

// ── the tailing loop on a fake clock ──────────────────────────────────────────

class Harness {
    now = 0;
    timers: Array<{ id: number; at: number; fn: () => void }> = [];
    private nextId = 1;
    written: string[] = [];
    stopped: StopReason[] = [];
    events: StreamEvent[] = [];
    snapshot: SnapshotRead = { frames: [{ key: "j", json: { status: "VALIDATING" } }], done: false };
    writeOk = true;
    reads = 0;
    loop!: TailLoop;

    constructor(
        readonly config: StreamConfig,
        startAfter = 0,
        opts: { earlierEvents?: number } = {},
        private readonly source?: { readEvents(afterId: number, limit: number): StreamEvent[]; overlap?: number },
    ) {
        this.loop = new TailLoop(
            {
                now: () => this.now,
                setTimer: (fn, ms) => {
                    const t = { id: this.nextId++, at: this.now + ms, fn };
                    this.timers.push(t);
                    return t.id;
                },
                clearTimer: (h) => {
                    this.timers = this.timers.filter((t) => t.id !== h);
                },
                readEvents: (after, limit) => {
                    this.reads++;
                    return this.source ? this.source.readEvents(after, limit) : this.events.filter((e) => e.id > after).slice(0, limit);
                },
                readSnapshots: () => this.snapshot,
                overlap: source?.overlap,
                write: async (chunk) => {
                    if (!this.writeOk) return false;
                    this.written.push(chunk);
                    return true;
                },
                onStop: (r) => this.stopped.push(r),
            },
            config,
            startAfter,
            opts,
        );
    }

    add(...ids: number[]): void {
        for (const id of ids) this.events.push({ id, at: "2026-01-01T00:00:00.000Z", level: "info", message: `e${id}`, stage: "validation", kind: "k", jobId: "j" });
    }
    async settle(): Promise<void> {
        for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
    }
    /** Run the next timer, moving the clock to it. */
    async tick(): Promise<void> {
        const t = this.timers.sort((a, b) => a.at - b.at)[0];
        if (!t) return;
        this.timers = this.timers.filter((x) => x !== t);
        this.now = Math.max(this.now, t.at);
        t.fn();
        await this.settle();
    }
    /** Frames as [event, id?] pairs. */
    frames(): Array<[string, number | undefined]> {
        return this.written.filter((w) => !w.startsWith(":") && !w.startsWith("retry")).map((w) => [/^event: (.+)$/m.exec(w)?.[1] ?? "?", /^id: (\d+)$/m.exec(w) ? Number(/^id: (\d+)$/m.exec(w)![1]) : undefined]);
    }
    logIds(): number[] {
        return this.frames().flatMap(([e, id]) => (e === "log" ? [id!] : []));
    }
}

describe("the tailing loop", () => {
    it("sends the snapshot first, then events in id order, and keeps going while nothing ends it", async () => {
        const h = new Harness(cfg());
        h.add(1, 2, 3);
        h.loop.start();
        await h.settle();
        expect(h.frames().map(([e]) => e)).toEqual(["job", "log", "log", "log"]);
        expect(h.logIds()).toEqual([1, 2, 3]);
        expect(h.timers).toHaveLength(1);
        h.add(4, 5);
        await h.tick();
        expect(h.logIds()).toEqual([1, 2, 3, 4, 5]);
        expect(h.stopped).toEqual([]);
        h.loop.stop();
        expect(h.timers).toHaveLength(0);
    });

    it("resumes after a position: nothing before it, nothing twice", async () => {
        const h = new Harness(cfg(), 2);
        h.add(1, 2, 3, 4);
        h.loop.start();
        await h.settle();
        expect(h.logIds()).toEqual([3, 4]);
        await h.tick();
        await h.tick();
        expect(h.logIds()).toEqual([3, 4]);
        h.loop.stop();
    });

    it("a source that repeats or goes backwards cannot make a duplicate", async () => {
        let call = 0;
        const stream = [[{ id: 5 }, { id: 6 }], [{ id: 5 }, { id: 6 }, { id: 7 }], [{ id: 3 }, { id: 7 }, { id: 8 }]];
        const h = new Harness(cfg(), 0, {}, {
            readEvents: () => (stream[Math.min(call++, 2)] as Array<{ id: number }>).map((e) => ({ id: e.id, at: "t", level: "info", message: "m", stage: "s", kind: "k", jobId: "j" })),
        });
        h.loop.start();
        await h.settle();
        await h.tick();
        await h.tick();
        expect(h.logIds()).toEqual([5, 6, 7, 8]);
        h.loop.stop();
    });

    it("with an overlap window, an id committed late (after a larger one) is sent once, and the resume id never goes back", async () => {
        // What the database shows: ids become visible in commit order, which on PostgreSQL need not be id order.
        const committed: number[] = [];
        const ev = (id: number): StreamEvent => ({ id, at: "t", level: "info", message: `e${id}`, stage: "s", kind: "k", jobId: "j" });
        const source = (overlap: number) => ({ overlap, readEvents: (after: number, limit: number) => committed.filter((id) => id > after).sort((a, b) => a - b).slice(0, limit).map(ev) });
        const h = new Harness(cfg({ pageSize: 2 }), 0, {}, source(10));
        const plain = new Harness(cfg({ pageSize: 2 }), 0, {}, source(0));
        committed.push(1, 2, 4); // 3 is handed out but not committed yet
        h.loop.start();
        plain.loop.start();
        await h.settle();
        expect(h.logIds()).toEqual([1, 2, 4]);
        committed.push(3, 5); // 3 commits late
        await h.tick();
        await plain.tick();
        await h.tick();
        expect(h.frames().filter(([e]) => e === "log").map(([, id]) => id)).toEqual([1, 2, 4, 4, 5]); // 3 goes out with resume id 4
        expect(h.written.filter((w) => w.includes('"id":3,')).length).toBe(1);
        expect(h.written.map((w) => /"id":(\d+),/.exec(w)?.[1]).filter(Boolean).map(Number)).toEqual([1, 2, 4, 3, 5]);
        expect(plain.logIds()).toEqual([1, 2, 4, 5]); // without the window, 3 is skipped for good
        // Later than the window (more than 10 newer ids went out first): the documented limit. It is not sent, and the position never moves back.
        committed.push(6, ...Array.from({ length: 28 }, (_, i) => 8 + i));
        await h.tick();
        committed.push(7, 36);
        await h.tick();
        await h.tick();
        const sent = h.written.map((w) => /"id":(\d+),/.exec(w)?.[1]).filter(Boolean).map(Number);
        expect(sent).toEqual([1, 2, 4, 3, 5, 6, ...Array.from({ length: 29 }, (_, i) => 8 + i)]);
        expect(new Set(sent).size).toBe(sent.length);
        expect(h.loop.position).toBe(36);
        h.loop.stop();
        plain.loop.stop();
    });

    it("a resume with an overlap window starts strictly after its position", async () => {
        const h = new Harness(cfg(), 4, {}, { overlap: 10, readEvents: (after, limit) => [1, 2, 3, 4, 5].filter((id) => id > after).slice(0, limit).map((id) => ({ id, at: "t", level: "info", message: "m", stage: "s", kind: "k", jobId: "j" })) });
        h.loop.start();
        await h.settle();
        await h.tick();
        expect(h.logIds()).toEqual([5]);
        h.loop.stop();
    });

    it("reads in pages and sends every event of a big backlog in order", async () => {
        const h = new Harness(cfg({ pageSize: 7 }));
        h.add(...Array.from({ length: 50 }, (_, i) => i + 1));
        h.loop.start();
        await h.settle();
        expect(h.logIds()).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
        h.loop.stop();
    });

    it("sends a snapshot again only when it changed", async () => {
        const h = new Harness(cfg());
        h.loop.start();
        await h.settle();
        await h.tick();
        expect(h.frames().filter(([e]) => e === "job")).toHaveLength(1);
        h.snapshot = { frames: [{ key: "j", json: { status: "VALIDATING", progress: 1 } }], done: false };
        await h.tick();
        expect(h.frames().filter(([e]) => e === "job")).toHaveLength(2);
        h.loop.stop();
    });

    it("says how many earlier events are not shown, in the first snapshot only", async () => {
        const h = new Harness(cfg(), 0, { earlierEvents: 12 });
        h.loop.start();
        await h.settle();
        h.snapshot = { frames: [{ key: "j", json: { status: "VALIDATING", n: 2 } }], done: false };
        await h.tick();
        const jobs = h.written.filter((w) => w.startsWith("event: job"));
        expect(jobs[0]).toContain('"earlierEvents":12');
        expect(jobs[1]).not.toContain("earlierEvents");
        h.loop.stop();
    });

    it("ends with the last events, the final snapshot and an end frame, then leaves no timer", async () => {
        const h = new Harness(cfg());
        h.add(1);
        h.loop.start();
        await h.settle();
        h.add(2, 3);
        h.snapshot = { frames: [{ key: "j", json: { status: "COMPLETED" } }], done: true, status: "COMPLETED" };
        await h.tick();
        expect(h.frames().map(([e]) => e)).toEqual(["job", "log", "log", "log", "job", "end"]);
        expect(h.logIds()).toEqual([1, 2, 3]);
        expect(h.written.at(-1)).toContain('"status":"COMPLETED"');
        expect(h.stopped).toEqual(["ended"]);
        expect(h.timers).toHaveLength(0);
        await h.tick();
        expect(h.frames().filter(([e]) => e === "end")).toHaveLength(1);
    });

    it("a job that is already finished still replays its events, then ends at once", async () => {
        const h = new Harness(cfg());
        h.snapshot = { frames: [{ key: "j", json: { status: "FAILED" } }], done: true, status: "FAILED" };
        h.add(1, 2);
        h.loop.start();
        await h.settle();
        expect(h.frames().map(([e]) => e)).toEqual(["job", "log", "log", "end"]);
        expect(h.timers).toHaveLength(0);
    });

    it("reads the snapshot before the events, so a terminal state never hides the events that came before it", async () => {
        // The job becomes terminal and one more event is written while the round is between its two reads.
        const order: string[] = [];
        let wrote = false;
        const h = new Harness(cfg(), 0, {}, {
            readEvents: (after) => {
                order.push("events");
                wrote = true;
                return after < 9 ? [{ id: 9, at: "t", level: "info", message: "late", stage: "s", kind: "k", jobId: "j" }] : [];
            },
        });
        Object.defineProperty(h, "snapshot", {
            get: () => {
                order.push("snapshot");
                return { frames: [{ key: "j", json: { status: wrote ? "COMPLETED" : "VALIDATING" } }], done: wrote, status: "COMPLETED" } as SnapshotRead;
            },
        });
        h.loop.start();
        await h.settle();
        expect(order.slice(0, 2)).toEqual(["snapshot", "events"]);
        // That first round saw VALIDATING (not done); the next sees done and ends after delivering event 9 exactly once.
        await h.tick();
        expect(h.logIds()).toEqual([9]);
        expect(h.stopped).toEqual(["ended"]);
    });

    it("wakes at once when told, without a second timer", async () => {
        const h = new Harness(cfg());
        h.loop.start();
        await h.settle();
        expect(h.timers).toHaveLength(1);
        h.add(1);
        h.loop.wake();
        await h.settle();
        expect(h.logIds()).toEqual([1]);
        expect(h.timers).toHaveLength(1);
        h.loop.stop();
    });

    it("a wake during a round runs one more round right after it", async () => {
        const h = new Harness(cfg());
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const orig = h.loop["deps"].write;
        let first = true;
        h.loop["deps"].write = async (chunk: string) => {
            if (first) {
                first = false;
                await gate;
            }
            return orig(chunk);
        };
        h.loop.start();
        await h.settle();
        h.add(1);
        h.loop.wake(); // lands while the first write is still pending
        release();
        await h.settle();
        expect(h.logIds()).toEqual([1]);
        expect(h.timers).toHaveLength(1);
        h.loop.stop();
    });

    it("polls fast while events flow and slows down while quiet", async () => {
        const h = new Harness(cfg({ pollMs: 100, maxPollMs: 400 }));
        h.add(1);
        h.loop.start();
        await h.settle();
        expect(h.timers[0]!.at - h.now).toBe(100);
        const gaps: number[] = [];
        for (let i = 0; i < 5; i++) {
            const before = h.now;
            await h.tick();
            gaps.push(h.timers[0]!.at - h.now);
            void before;
        }
        expect(gaps).toEqual([150, 225, 338, 400, 400]);
        h.add(2);
        await h.tick();
        expect(h.timers[0]!.at - h.now).toBe(100);
        h.loop.stop();
    });

    it("writes a keep-alive comment after a quiet spell, and not while events flow", async () => {
        const h = new Harness(cfg({ heartbeatMs: 1_000, pollMs: 100, maxPollMs: 400 }));
        h.loop.start();
        await h.settle();
        expect(h.written.some((w) => w.startsWith(": keep-alive"))).toBe(false);
        for (let i = 0; i < 12; i++) await h.tick();
        const beats = h.written.filter((w) => w.startsWith(": keep-alive"));
        expect(beats.length).toBeGreaterThanOrEqual(1);
        const n = beats.length;
        h.add(1, 2);
        await h.tick();
        expect(h.written.filter((w) => w.startsWith(": keep-alive")).length).toBe(n);
        h.loop.stop();
    });

    it("closes after its maximum age without an end frame, so the browser reconnects and resumes", async () => {
        const h = new Harness(cfg({ maxAgeMs: 5_000, pollMs: 1_000, maxPollMs: 1_000, heartbeatMs: 60_000 }));
        h.add(1);
        h.loop.start();
        await h.settle();
        for (let i = 0; i < 10 && h.stopped.length === 0; i++) await h.tick();
        expect(h.stopped).toEqual(["max-age"]);
        expect(h.frames().some(([e]) => e === "end")).toBe(false);
        expect(h.timers).toHaveLength(0);
    });

    it("stops when the client is gone or too slow, with the position left where the last sent event was", async () => {
        const h = new Harness(cfg());
        h.add(1, 2);
        h.loop.start();
        await h.settle();
        expect(h.loop.position).toBe(2);
        h.writeOk = false;
        h.add(3);
        await h.tick();
        expect(h.stopped).toEqual(["client"]);
        expect(h.loop.position).toBe(2); // 3 was not delivered, so a resume after 2 sends it
        expect(h.timers).toHaveLength(0);
    });

    it("an error reading the database ends that stream and leaves no timer", async () => {
        const h = new Harness(cfg(), 0, {}, {
            readEvents: () => {
                throw new Error("database is locked");
            },
        });
        h.loop.start();
        await h.settle();
        expect(h.stopped).toEqual(["error"]);
        expect(h.timers).toHaveLength(0);
    });

    it("stop is final: later wakes and timers do nothing", async () => {
        const h = new Harness(cfg());
        h.loop.start();
        await h.settle();
        h.loop.stop();
        h.add(1);
        h.loop.wake();
        await h.settle();
        expect(h.logIds()).toEqual([]);
        expect(h.timers).toHaveLength(0);
        expect(h.stopped).toEqual(["stopped"]);
    });
});

describe("settings", () => {
    it("have the documented defaults and can be tuned within bounds", () => {
        const d = streamConfig({});
        expect(d).toMatchObject({ pollMs: 250, heartbeatMs: 15_000, maxAgeMs: 2 * 3_600_000, maxStreams: 100, maxPerKey: 20, ticketTtlMs: 60_000, initialEvents: 500 });
        const t = streamConfig({ STREAM_MAX_STREAMS: "3", STREAM_POLL_MS: "1", STREAM_HEARTBEAT_MS: "abc" } as never);
        expect(t.maxStreams).toBe(3);
        expect(t.pollMs).toBe(10);
        expect(t.heartbeatMs).toBe(15_000);
    });
});

// ── what the agent sends ──────────────────────────────────────────────────────

import { BeatPacer } from "../src/agent/beat-pacer.js";
import { ProgressParser, type RunProgress } from "../src/engine/validation/runner.js";

describe("reading the test runner's progress", () => {
    const parse = (text: string, chunk = 1000): RunProgress[] => {
        const out: RunProgress[] = [];
        const p = new ProgressParser((x) => out.push(x));
        for (let i = 0; i < text.length; i += chunk) p.push(text.slice(i, i + chunk));
        return out;
    };
    const sample = ["", "Running 3 tests using 2 workers", "", "  ok 1 t1.spec.ts:2:1 › script 1 does a thing (310ms)", "  ok 2 [chromium] › t2.spec.ts:2:1 › script 2 does a thing (1.2s)", "  x  3 t3.spec.ts:2:1 › script 3 fails (920ms)", "", "  1) t3.spec.ts:2:1 › script 3 fails", "    Error: expect(received).toBe(expected)", "  1 failed", "  2 passed (3.2s)", ""].join("\n");

    it("turns finished-test lines into done/total, status and the plain title", () => {
        expect(parse(sample)).toEqual([
            { done: 1, total: 3, status: "passed", title: "script 1 does a thing" },
            { done: 2, total: 3, status: "passed", title: "script 2 does a thing" },
            { done: 3, total: 3, status: "failed", title: "script 3 fails" },
        ]);
    });
    it("gives the same answer however the output is cut into chunks, and with Windows line ends", () => {
        const want = parse(sample);
        expect(parse(sample, 7)).toEqual(want);
        expect(parse(sample.replace(/\n/g, "\r\n"), 1)).toEqual(want);
    });
    it("reads a skipped test, ignores failure details and summaries, and ignores lines before it knows the total", () => {
        const out = parse("  ok 1 a.spec.ts:1:1 › early (1ms)\nRunning 2 tests using 1 worker\n  -  1 a.spec.ts:1:1 › skipped one\n    ok 5 inside an error message\n  1 skipped\n");
        expect(out.map((x) => [x.status, x.title])).toEqual([["skipped", "skipped one"], ["passed", "inside an error message"]]);
    });
    it("never counts past the total", () => {
        const out = parse("Running 1 test using 1 worker\n  ok 1 a.spec.ts:1:1 › a (1ms)\n  ok 2 a.spec.ts:1:1 › b (1ms)\n");
        expect(out.map((x) => x.done)).toEqual([1, 1]);
    });
});

describe("when the agent's next heartbeat is due", () => {
    const abort = () => new AbortController();
    it("is the full interval when nothing is waiting", async () => {
        const p = new BeatPacer(300, 100);
        p.markBeat();
        const t0 = Date.now();
        await p.wait(abort().signal, () => false);
        expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
    });
    it("is soon after a line is queued, but not sooner than the minimum gap after the last beat", async () => {
        const p = new BeatPacer(5_000, 200);
        p.markBeat();
        const t0 = Date.now();
        const w = p.wait(abort().signal, () => false);
        setTimeout(() => p.nudge(), 20);
        await w;
        const took = Date.now() - t0;
        expect(took).toBeGreaterThanOrEqual(150);
        expect(took).toBeLessThan(1_500);
    });
    it("lines that were already waiting count at once", async () => {
        const p = new BeatPacer(5_000, 100);
        p.markBeat();
        const t0 = Date.now();
        await p.wait(abort().signal, () => true);
        expect(Date.now() - t0).toBeLessThan(1_500);
    });
    it("the minimum gap defaults to one second and never exceeds the interval", async () => {
        let now = 10_000;
        const p = new BeatPacer(20_000, undefined, () => now);
        expect(p["minGapMs"]).toBe(1000);
        expect(new BeatPacer(400)["minGapMs"]).toBe(400);
        void now;
    });
    it("ends at once when the task ends and leaves no timer or listener behind", async () => {
        const ac = abort();
        const p = new BeatPacer(60_000, 1_000);
        p.markBeat();
        const w = p.wait(ac.signal, () => false);
        ac.abort();
        await w;
        expect(p["nudged"]).toBeUndefined();
        await p.wait(ac.signal, () => false); // already aborted: returns immediately
    });
});
