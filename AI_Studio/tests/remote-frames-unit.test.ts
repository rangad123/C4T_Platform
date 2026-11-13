/**
 * Watch live on a runner (src/agent/remote-frames.ts): the frame target asks the platform whether anyone watches, and the engine's frame sink
 * takes no picture until the answer is yes. A picture is sent once, never while another is on its way, and a refusal stops pictures.
 */
import { describe, expect, it } from "vitest";
import { remoteFrameTarget } from "../src/agent/remote-frames.js";
import type { ExploreRoute } from "../src/agent/explore-transport.js";
import { createFrameSink } from "../src/engine/frames/sink.js";
import { requestSecrets } from "../src/platform/explore-task.js";
import { FrameHub, REASONS, watchState } from "../src/platform/frame-hub.js";

const facts = { note: "Opened /", phase: "exploring" as const, pagesSeen: 1 };
const shot = { jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), url: "http://127.0.0.1/", title: "Home" };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function platformDouble() {
    const calls: Array<{ route: ExploreRoute; body: any }> = [];
    let watched = false;
    let refuse = false;
    return {
        calls,
        set watched(v: boolean) {
            watched = v;
        },
        set refuse(v: boolean) {
            refuse = v;
        },
        post: async (route: ExploreRoute, body: unknown) => {
            calls.push({ route, body });
            if (refuse) throw Object.assign(new Error("gone"), { name: "ExplorePostError", status: 409 });
            return { watched };
        },
    };
}

describe("the runner's Watch live target", () => {
    it("takes no picture while nobody watches, starts once the platform says someone does, and stops again", async () => {
        const p = platformDouble();
        const stop = new AbortController();
        const target = remoteFrameTarget({ post: p.post, signal: stop.signal, pollMs: 30 });
        let shots = 0;
        const sink = createFrameSink(target, { minGapMs: 0, shoot: async () => (shots++, shot) });
        try {
            for (let i = 0; i < 5; i++) {
                await sink.capture({} as never, facts);
                await wait(40);
            }
            expect(shots).toBe(0);
            expect(sink.captures).toBe(0);
            expect(p.calls.every((c) => c.route === "frame" && c.body.frame === undefined)).toBe(true);
            expect(p.calls.length).toBeGreaterThan(1);

            p.watched = true;
            await wait(80);
            await sink.capture({} as never, facts);
            await wait(20);
            expect(shots).toBe(1);
            expect(target.sent).toBe(1);
            const sent = p.calls.filter((c) => c.body.frame);
            expect(sent).toHaveLength(1);
            expect(sent[0]!.body.frame).toMatchObject({ imageBase64: Buffer.from(shot.jpeg).toString("base64"), url: shot.url, title: "Home", note: "Opened /", phase: "exploring", pagesSeen: 1 });

            p.watched = false;
            await wait(80);
            await sink.capture({} as never, facts);
            expect(shots).toBe(1);
        } finally {
            stop.abort();
        }
    });

    it("never sends a picture while another is on its way, and a refusal stops pictures", async () => {
        let release!: () => void;
        const held = new Promise<void>((r) => (release = r));
        const calls: unknown[] = [];
        let first = true;
        const post = async (_route: ExploreRoute, body: unknown) => {
            calls.push(body);
            if (first) {
                first = false;
                return { watched: true };
            }
            await held;
            throw Object.assign(new Error("no longer ours"), { name: "ExplorePostError", status: 409 });
        };
        const stop = new AbortController();
        const target = remoteFrameTarget({ post, signal: stop.signal, pollMs: 10_000 });
        await wait(10);
        expect(target.wanted()).toBe(true);
        const f = { jpeg: shot.jpeg, url: shot.url, title: "Home", note: "x", phase: "exploring" as const, pagesSeen: 1, at: new Date().toISOString() };
        target.accept(f);
        expect(target.wanted()).toBe(false);
        target.accept(f);
        expect(target.sent).toBe(1);
        release();
        await wait(10);
        expect(target.wanted()).toBe(false);
        target.accept(f);
        expect(target.sent).toBe(1);
        stop.abort();
    });

    it("stops asking when the exploration ends", async () => {
        const p = platformDouble();
        const stop = new AbortController();
        remoteFrameTarget({ post: p.post, signal: stop.signal, pollMs: 20 });
        await wait(70);
        stop.abort();
        const n = p.calls.length;
        await wait(80);
        expect(p.calls.length).toBe(n);
    });

    it("covers the same stored sign-in values as the server does (the job's account, its roles, a saved sign-in)", () => {
        const secrets = requestSecrets({
            credentials: { username: "shopper@example.test", password: "Pass-word-1", totpSecret: "JBSWY3DPEHPK3PXP" },
            roles: [{ name: "admin", username: "a@example.test", password: "Admin-pass-2" }] as never,
        });
        expect(secrets).toEqual(expect.arrayContaining(["Pass-word-1", "JBSWY3DPEHPK3PXP", "Admin-pass-2"]));
        expect(secrets).not.toContain("shopper@example.test");
    });
});

describe("what the page is told for an exploration on a runner", () => {
    const exploring = { status: "DISCOVERING", options: { mode: "generate" }, cancelRequested: false } as never;
    it("may be watched when the runner sends pictures, even though no job of this process runs (the picture says it is on the runner)", () => {
        const hub = new FrameHub();
        expect(hub.canServe).toBe(false);
        expect(watchState(exploring, { hub, runner: { frames: true } })).toEqual({ canWatch: true, onRunner: true });
        expect(watchState(exploring, { hub })).toMatchObject({ canWatch: false, why: "unavailable" });
    });
    it("an older runner is told in words, not left waiting for a picture", () => {
        expect(watchState(exploring, { hub: new FrameHub(), runner: { frames: false } })).toEqual({ canWatch: false, why: "elsewhere", reason: REASONS.oldRunner });
    });
    it("a runner's picture does not make this process look like a worker that can show its own jobs", () => {
        const hub = new FrameHub();
        hub.put("job-1", { jpeg: new Uint8Array([0xff, 0xd8]), url: "u", title: "t", note: "n", phase: "exploring", pagesSeen: 1, at: "a" }, { fromRunner: true });
        expect(hub.latest("job-1")).toBeDefined();
        expect(hub.canServe).toBe(false);
    });
});
