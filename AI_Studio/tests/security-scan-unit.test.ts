/**
 * The passive assessment's scan() orchestration (src/security/assessment/scan.ts), without a browser, a server or the network: a fake
 * Guard records what was actually sent and can refuse, fail transiently or hit the request cap. This pins the read-only probe sequence
 * that the full runner only exercised end to end: which addresses are requested, that excluded and refused paths are never sent, that the
 * request cap stops the scan, that the TLS handshake is attempted only on https, and that a retest asks only for its own addresses.
 */
import { describe, expect, it } from "vitest";
import { scan } from "../src/security/assessment/scan.js";
import { emptyDiscovery } from "../src/security/assessment/discover.js";
import { RefusedError, RequestCapError, type DiscoveryResult, type Guard, type GuardedAnswer, type GuardFetchInit } from "../src/security/assessment/types.js";

/** A stand-in for the scope guard: it never touches the network, records every fetch, and can be told to refuse, fail or cap. */
class FakeGuard implements Guard {
    /** Addresses actually sent (the cap and refusals are decided before the push, like the real guard). */
    sent: string[] = [];
    /** TLS-only hooks: proof observeTls was or was not reached. */
    tlsCalls = 0;
    private count = 0;

    constructor(
        private readonly opts: {
            capAfter?: number;
            refuse?: (path: string) => string | undefined;
            transient?: Set<string>;
            bodyFor?: (path: string) => string;
        } = {},
    ) {}

    async refusal(url: string): Promise<string | undefined> {
        return this.opts.refuse?.(new URL(url).pathname);
    }
    async fetch(url: string, _init: GuardFetchInit = {}): Promise<GuardedAnswer> {
        const path = new URL(url).pathname;
        if (this.count >= (this.opts.capAfter ?? Infinity)) throw new RequestCapError();
        this.count++;
        const refusal = this.opts.refuse?.(path);
        if (refusal) throw new RefusedError(url, refusal);
        if (this.opts.transient?.has(path)) throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
        this.sent.push(url);
        const text = this.opts.bodyFor?.(path) ?? "";
        return { url, status: 200, headers: { "content-type": "text/html" }, setCookies: [], body: Buffer.from(text), text };
    }
    async pinnedAddress(): Promise<string | undefined> {
        this.tlsCalls++;
        return "203.0.113.9";
    }
    async take(): Promise<void> {
        this.tlsCalls++;
    }
    requestsSent(): number {
        return this.count;
    }
}

const discovery = (startUrl: string, extra: Partial<DiscoveryResult> = {}): DiscoveryResult => ({ ...emptyDiscovery(startUrl), ...extra });
const paths = (urls: string[]) => urls.map((u) => new URL(u).pathname);

describe("scan(): the read-only probe sequence", () => {
    it("requests the file, listing and cross-origin probes over http, and never reads a certificate on http", async () => {
        const guard = new FakeGuard();
        const res = await scan(guard, discovery("http://app.test/"), { signal: new AbortController().signal, excludedPaths: [] });
        const sent = paths(guard.sent);
        // Known read-only probes from the engine's lists.
        expect(sent).toContain("/.env");
        expect(sent).toContain("/.git/config");
        expect(sent).toContain("/backup.zip");
        expect(sent).toContain("/uploads/");
        // The cross-origin probe is the home path, sent with the made-up Origin.
        expect(sent).toContain("/");
        expect(res.capReached).toBe(false);
        // No TLS handshake on a plain-http home.
        expect(guard.tlsCalls).toBe(0);
        expect(res.outcomes.some((o) => /certificate/i.test(o.step))).toBe(false);
        // Everything that was requested is reported for the coverage list.
        expect(res.requested.length).toBe(guard.sent.length);
    });

    it("never sends an excluded path, and lists it as not requested", async () => {
        const guard = new FakeGuard();
        const res = await scan(guard, discovery("http://app.test/"), { signal: new AbortController().signal, excludedPaths: ["/uploads"] });
        expect(paths(guard.sent)).not.toContain("/uploads/");
        expect(paths(guard.sent)).toContain("/files/");
        const note = res.outcomes.find((o) => /Excluded or refused/i.test(o.step));
        expect(note?.reason).toMatch(/\/uploads\//);
    });

    it("stops at the request cap: the remaining probes are not sent, and the cap is reported", async () => {
        const guard = new FakeGuard({ capAfter: 3 });
        const res = await scan(guard, discovery("http://app.test/"), { signal: new AbortController().signal, excludedPaths: [] });
        expect(res.capReached).toBe(true);
        // Three were actually sent; `requested` also counts the probe that tripped the cap (it was asked for, then refused by the budget).
        expect(guard.sent.length).toBe(3);
        expect(res.requested.length).toBe(4);
        expect(res.outcomes.some((o) => !o.ok && /most requests/i.test(o.reason ?? ""))).toBe(true);
    });

    it("treats a refusal as not-requested, but a transient failure that exhausts its retries as a failed step", async () => {
        const guard = new FakeGuard({ refuse: (p) => (p === "/backup.zip" ? "That path is out of scope." : undefined), transient: new Set(["/phpinfo.php"]) });
        const res = await scan(guard, discovery("http://app.test/"), { signal: new AbortController().signal, excludedPaths: [], retries: 0 });
        // Refused: never sent, named in the "not requested" note, and not a failed step.
        expect(paths(guard.sent)).not.toContain("/backup.zip");
        expect(res.outcomes.find((o) => /Excluded or refused/i.test(o.step))?.reason).toMatch(/\/backup\.zip/);
        // Transient and unrecoverable: a failed step (the assessment is then partial), not silently dropped.
        expect(res.outcomes.some((o) => !o.ok && /\/phpinfo\.php|request failed/i.test(`${o.step} ${o.reason}`))).toBe(true);
    });

    it("a retest asks only for its own addresses and only for the categories it names", async () => {
        const guard = new FakeGuard();
        const res = await scan(guard, discovery("http://app.test/"), {
            signal: new AbortController().signal,
            excludedPaths: [],
            only: { urls: ["http://app.test/.env"], categories: ["exposed-files"] },
        });
        // Only the finding's own address, and no cross-origin probe (that category was not asked for).
        expect(guard.sent).toEqual(["http://app.test/.env"]);
        expect(res.requested).toEqual(["http://app.test/.env"]);
        expect(res.capReached).toBe(false);
    });

    it("does not attempt the certificate handshake once the request cap was already reached on https", async () => {
        const guard = new FakeGuard({ capAfter: 0 });
        const res = await scan(guard, discovery("https://app.test/"), { signal: new AbortController().signal, excludedPaths: [] });
        expect(res.capReached).toBe(true);
        expect(guard.sent).toEqual([]);
        expect(guard.tlsCalls).toBe(0);
        expect(res.outcomes.some((o) => /certificate/i.test(o.step))).toBe(false);
    });

    it("throws when the assessment is cancelled, rather than returning a partial result", async () => {
        const ctl = new AbortController();
        ctl.abort();
        await expect(scan(new FakeGuard(), discovery("http://app.test/"), { signal: ctl.signal, excludedPaths: [] })).rejects.toThrow(/cancelled/i);
    });
});
