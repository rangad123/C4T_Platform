/**
 * Failure evidence, browser-free: the redaction rules (the part that must be right), the strict parsing of an attachment,
 * the recorder's caps (with a scripted page, no browser), the summary sentences, and the shape of the generated script.
 */
import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { loadEvidenceRuntime, EVIDENCE_HELPER_SOURCE, EVIDENCE_MAX_CONSOLE, EVIDENCE_MAX_REQUESTS, EVIDENCE_MAX_TEXT } from "../src/engine/evidence/capture.js";
import { parseEvidence, sanitizeEvidence, secretsOfRun, type Evidence } from "../src/engine/evidence/model.js";
import { highlights, summarize } from "../src/engine/evidence/summary.js";
import { renderScript } from "../src/engine/generators/index.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { buildIssueDraft, toMarkdown } from "../src/platform/issues/content.js";

const rt = loadEvidenceRuntime();
const text = (s: string, secrets: string[] = []) => rt.evidenceText(s, secrets);
const url = (u: string, secrets: string[] = []) => rt.evidenceSplitUrl(u, "app.test", secrets);

describe("redaction: query strings", () => {
    it("hides the value of any parameter whose name suggests a secret, keeps the rest", () => {
        const u = url("https://app.test/cb?token=abc&api_key=k1&apikey=k2&secret=s&password=p&passwd=q&pwd=r&auth=a&Authorization=b&session=x&sessionid=y&code=123456&otp=987654&access_token=t&refresh_token=u&id_token=v&signature=w&q=shoes&page=2&keyword=boots");
        expect(u.path).toBe("/cb?token=[hidden]&api_key=[hidden]&apikey=[hidden]&secret=[hidden]&password=[hidden]&passwd=[hidden]&pwd=[hidden]&auth=[hidden]&Authorization=[hidden]&session=[hidden]&sessionid=[hidden]&code=[hidden]&otp=[hidden]&access_token=[hidden]&refresh_token=[hidden]&id_token=[hidden]&signature=[hidden]&q=shoes&page=2&keyword=boots");
    });
    it("matches names whatever their case or encoding", () => {
        expect(url("https://app.test/x?API-KEY=1&Pass%57ord=2&se%73sion=3&A=b").path).toBe("/x?API-KEY=[hidden]&Pass%57ord=[hidden]&se%73sion=[hidden]&A=b");
    });
    it("drops credentials in the address and the fragment; keeps another site's host", () => {
        expect(url("https://user:hunter2@app.test/home?x=1#access_token=zzz")).toEqual({ path: "/home?x=1" });
        expect(url("https://cdn.other.test:8443/a.js?v=3")).toEqual({ host: "cdn.other.test:8443", path: "/a.js?v=3" });
    });
    it("hides a secret inside a harmless parameter, also when URL-encoded or form-encoded", () => {
        const secret = "p@ss w/ord&1";
        const secrets = rt.evidenceSecrets([secret]);
        expect(url(`https://app.test/x?next=${encodeURIComponent(secret)}&b=1`, secrets).path).toBe("/x?next=[hidden]&b=1");
        expect(url(`https://app.test/x?next=${encodeURIComponent(secret).replace(/%20/g, "+")}`, secrets).path).toBe("/x?next=[hidden]");
        expect(url(`https://app.test/x?next=${encodeURIComponent(secret).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())}`, secrets).path).toBe("/x?next=[hidden]");
        // in the path as well
        expect(url(`https://app.test/reset/${encodeURIComponent(secret)}/done`, secrets).path).toBe("/reset/[hidden]/done");
    });
    it("hides tokens that look like tokens in the path and in harmless parameters", () => {
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        expect(url(`https://app.test/verify/${"a1".repeat(24)}?ref=${jwt}`).path).toBe("/verify/[hidden]?ref=[hidden]");
        // an ordinary UUID is an id, not a secret
        expect(url("https://app.test/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301").path).toBe("/orders/3f2504e0-4f89-11d3-9a0c-0305e82c3301");
    });
    it("copes with addresses it cannot parse", () => {
        expect(url("not a url", rt.evidenceSecrets(["sekret-value-1"])).path).toBe("not a url");
        expect(url("not a url sekret-value-1", rt.evidenceSecrets(["sekret-value-1"])).path).toBe("not a url [hidden]");
    });
});

describe("redaction: console text", () => {
    it("masks bearer tokens, JWTs, cookies, key=value pairs, vendor keys and long hex / base64 strings", () => {
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        expect(text("Authorization: Bearer abc123def456")).toBe("Authorization: [hidden] [hidden]");
        expect(text("sent Bearer abc123def456 ok")).toBe("sent Bearer [hidden] ok");
        expect(text(`jwt ${jwt} end`)).toBe("jwt [hidden] end");
        expect(text("Cookie: sid=abc; theme=dark\nnext line")).toBe("Cookie: [hidden]\nnext line");
        expect(text("Set-Cookie: sid=abc; HttpOnly")).toBe("Set-Cookie: [hidden]");
        expect(text('login {"user":"ann","password":"hunter2","remember":true}')).toBe('login {"user":"ann","password":"[hidden]","remember":true}');
        expect(text("password=hunter2 and api_key: 'k-123' and token = abc")).toBe("password=[hidden] and api_key: '[hidden]' and token = [hidden]");
        expect(text("key sk_live_51Habcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz123456 and AKIAIOSFODNN7EXAMPLE")).toBe("key [hidden] and [hidden] and [hidden]");
        expect(text(`digest ${"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"} and ${"Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo"}`)).toBe("digest [hidden] and [hidden]");
    });
    it("masks addresses inside text the same way as request addresses", () => {
        expect(text("fetch failed for https://u:pw@api.test/v1/me?token=abc&lang=en#frag")).toBe("fetch failed for https://api.test/v1/me?token=[hidden]&lang=en");
    });
    it("keeps ordinary messages readable", () => {
        for (const msg of ["Could not add to cart: the server answered 500", "TypeError: Cannot read properties of undefined (reading 'id')", "Failed to load resource: the server responded with a status of 404 (Not Found)", "Warning: Each child in a list should have a unique \"key\" prop.", "status code: 500", "bearer token required", "Basic information saved"]) {
            expect(text(msg), msg).toBe(msg);
        }
    });
    it("masks the run's exact credentials first, in every common form, including at the very end of a long message", () => {
        const secrets = rt.evidenceSecrets(["Tr0ub4dor&3"]);
        expect(text("a Tr0ub4dor&3 b Tr0ub4dor%263 c", secrets)).toBe("a [hidden] b [hidden] c");
        // a message longer than the 2 KB limit with the secret straddling the cut: masked before it is shortened
        const filler = "x ".repeat(EVIDENCE_MAX_TEXT / 2 - 5);
        const out = text(`${filler}Tr0ub4dor&3 and more`, secrets);
        expect(out.length).toBeLessThanOrEqual(EVIDENCE_MAX_TEXT);
        expect(out).not.toContain("Tr0ub4dor");
        expect(out).not.toContain("Tr0u");
    });
    it("reads credentials from the environment variables a script is given", () => {
        process.env.TEST_PASSWORD = "env-pw-12345";
        process.env.TEST_ADMIN_API_TOKEN = "env-tok-67890";
        process.env.API_AUTH_HEADER = "X-Api-Key: header-val-1357";
        try {
            const secrets = rt.evidenceSecrets();
            expect(text("pw env-pw-12345 tok env-tok-67890 hdr header-val-1357 full X-Api-Key: header-val-1357", secrets)).toBe("pw [hidden] tok [hidden] hdr [hidden] full [hidden]");
        } finally {
            delete process.env.TEST_PASSWORD;
            delete process.env.TEST_ADMIN_API_TOKEN;
            delete process.env.API_AUTH_HEADER;
        }
    });
    it("is idempotent and never throws on odd input", () => {
        const messy = 'x=1 token=abc Bearer q1w2e3r4t5 https://a.test/p?password=z&k=v {"secret":"s"} [hidden]';
        expect(text(text(messy))).toBe(text(messy));
        for (const odd of ["", "\u0000\u0001", "😀".repeat(5000), "=".repeat(9000), "a".repeat(100_000), undefined as unknown as string, null as unknown as string]) expect(() => text(odd)).not.toThrow();
    });
    it("stays fast on hostile input", () => {
        const t0 = Date.now();
        text("a".repeat(9000) + "=".repeat(9000) + ":".repeat(9000) + "a-".repeat(5000));
        expect(Date.now() - t0).toBeLessThan(1500);
    });
});

describe("secretsOfRun", () => {
    it("lists passwords, authenticator secrets, tokens and the header (not user names), with their encoded forms", () => {
        const s = secretsOfRun({ credentials: { password: "pw one!", totpSecret: "KRSXG5CTMVRXEZLU" }, apiToken: "tok-111", apiAuthHeader: "X-Key: kv-2222", roles: [{ password: "adminpw", apiToken: "admtok1" }] });
        for (const needle of ["pw one!", "pw%20one!", "pw+one!", "KRSXG5CTMVRXEZLU", "tok-111", "X-Key: kv-2222", "kv-2222", "adminpw", "admtok1"]) expect(s, needle).toContain(needle);
    });
});

describe("sanitizeEvidence: an attachment is never trusted", () => {
    const good = (): Evidence => ({
        v: 1,
        durationMs: 1200,
        counts: { requests: 2, requestsKept: 2, console: 1, consoleKept: 1 },
        steps: [{ n: 1, t: 5 }],
        requests: [
            { t: 5, step: 1, method: "GET", type: "document", path: "/", status: 200, ms: 30, size: 1200 },
            { t: 40, step: 1, method: "POST", type: "fetch", path: "/api/cart", status: 500, ms: 80 },
        ],
        console: [{ t: 41, step: 1, type: "error", text: "boom" }],
    });
    it("accepts what a script writes, unchanged", () => {
        expect(sanitizeEvidence(good())).toEqual(good());
    });
    it("drops fields it does not know (headers, bodies, cookies), so a script cannot smuggle them in", () => {
        const forged = good() as unknown as { requests: Array<Record<string, unknown>> };
        forged.requests[1] = { ...forged.requests[1]!, headers: { authorization: "Bearer leak" }, body: "card=4111", cookies: "sid=1", responseBody: "secret" };
        const out = JSON.stringify(sanitizeEvidence(forged));
        for (const key of ["headers", "body", "cookies", "responseBody", "4111", "Bearer leak"]) expect(out).not.toContain(key);
    });
    it("masks again on the platform side, with the run's credentials", () => {
        const e = good();
        e.requests[1]!.path = "/api/cart?note=hunter2hunter2&password=abc&code=1";
        e.console[0]!.text = "typed hunter2hunter2 then Bearer abcdef123456";
        const out = sanitizeEvidence(e, rt.evidenceSecrets(["hunter2hunter2"]))!;
        expect(out.requests[1]!.path).toBe("/api/cart?note=[hidden]&password=[hidden]&code=[hidden]");
        expect(out.console[0]!.text).toBe("typed [hidden] then Bearer [hidden]");
    });
    it("rejects things that are not evidence, and bad entries inside real evidence", () => {
        for (const junk of [null, 1, "x", [], {}, { v: 2 }, { ...good(), counts: "many" }]) expect(sanitizeEvidence(junk)).toBeUndefined();
        const mixed = good() as unknown as { requests: unknown[] };
        mixed.requests.push({ nonsense: true }, { t: "late", step: 1, method: "GET", type: "x", path: "/" });
        expect(sanitizeEvidence(mixed)!.requests).toHaveLength(2);
        expect(parseEvidence("{not json")).toBeUndefined();
        expect(parseEvidence("x".repeat(5_000_000))).toBeUndefined();
    });
    it("caps lists and the stored size, dropping uninteresting entries first", () => {
        const e = good();
        e.requests = Array.from({ length: 700 }, (_, i) => ({ t: i, step: 1, method: "GET", type: "fetch", path: `/api/n?i=${i}`, status: i === 3 ? 500 : 200 }));
        e.counts.requests = 700;
        const out = sanitizeEvidence(e)!;
        expect(out.requests).toHaveLength(EVIDENCE_MAX_REQUESTS);
        expect(out.requests.some((r) => r.status === 500)).toBe(true); // the old failure outlived 400 newer boring entries
        expect(out.counts).toMatchObject({ requests: 700, requestsKept: EVIDENCE_MAX_REQUESTS });
        const big = good();
        big.console = Array.from({ length: 300 }, (_, i) => ({ t: i, step: 1, type: i % 10 === 0 ? "error" : "log", text: "y ".repeat(EVIDENCE_MAX_TEXT / 2) }));
        const bigOut = sanitizeEvidence(big)!;
        expect(bigOut.console).toHaveLength(EVIDENCE_MAX_CONSOLE);
        expect(JSON.stringify(bigOut).length).toBeLessThanOrEqual(600_000);
    });
});

/** A page that only emits events: enough to exercise the recorder's bookkeeping without a browser. */
function fakePage() {
    const page = new EventEmitter() as EventEmitter & { context(): { on(): void } };
    page.context = () => ({ on: () => undefined });
    const request = (n: number, status?: number) => {
        const r = { url: () => `http://app.test/api/n?i=${n}`, method: () => "GET", resourceType: () => "fetch", failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }) };
        page.emit("request", r);
        if (status !== undefined) page.emit("response", { request: () => r, status: () => status, headers: () => ({ "content-length": "10", "set-cookie": "sid=SECRET-COOKIE-VALUE" }) });
        return r;
    };
    return { page, request };
}

describe("the recorder (scripted page)", () => {
    it("keeps at most 300 requests and 200 console lines, prefers to drop boring ones, counts everything", () => {
        const { page, request } = fakePage();
        const rec = rt.installEvidence(page, "http://app.test/") as unknown;
        request(0, 500);
        for (let i = 1; i < 1000; i++) request(i, 200);
        for (let i = 0; i < 500; i++) page.emit("console", { type: () => (i === 0 ? "error" : "log"), text: () => `line ${i}`, location: () => ({ url: "http://app.test/app.js", lineNumber: 7 }) });
        page.emit("pageerror", new Error("late crash"));
        const out = rt.evidenceSerialize(rec, []) as Evidence;
        expect(out.requests).toHaveLength(EVIDENCE_MAX_REQUESTS);
        expect(out.counts).toMatchObject({ requests: 1000, requestsKept: 300, console: 501, consoleKept: 200 });
        expect(out.requests[0]).toMatchObject({ path: "/api/n?i=0", status: 500 }); // the failure survived 700 later successes
        expect(out.console.some((c) => c.type === "error" && c.text === "line 0")).toBe(true);
        expect(out.console.at(-1)).toMatchObject({ type: "pageerror", text: "late crash" });
        expect(out.console[1]).toMatchObject({ loc: "/app.js:7" });
        // sizes come from the length only; the header values themselves are never read into the evidence
        expect(JSON.stringify(out)).not.toContain("SECRET-COOKIE-VALUE");
        expect(out.requests[0]).toMatchObject({ size: 10 });
    });
    it("marks requests that never got an answer, failed, or were cancelled; labels them with the step", () => {
        const { page, request } = fakePage();
        const rec = rt.installEvidence(page, "http://app.test/");
        rt.evidenceStep(page, 2);
        const pending = request(1);
        const failed = request(2);
        page.emit("requestfailed", failed);
        const aborted = request(3);
        (aborted as { failure: () => { errorText: string } }).failure = () => ({ errorText: "net::ERR_ABORTED" });
        page.emit("requestfailed", aborted);
        void pending;
        const out = rt.evidenceSerialize(rec, []) as Evidence;
        expect(out.requests[0]).toMatchObject({ step: 2, pending: true });
        expect(out.requests[1]).toMatchObject({ failed: "net::ERR_CONNECTION_REFUSED" });
        expect(out.requests[2]).toMatchObject({ failed: "net::ERR_ABORTED", aborted: true });
        expect(out.steps).toEqual([expect.objectContaining({ n: 2 })]);
    });
    it("ignores data: and blob: addresses", () => {
        const { page } = fakePage();
        const rec = rt.installEvidence(page, "http://app.test/");
        page.emit("request", { url: () => "data:image/png;base64,AAAA", method: () => "GET", resourceType: () => "image" });
        expect((rt.evidenceSerialize(rec, []) as Evidence).requests).toHaveLength(0);
    });
});

describe("the summary", () => {
    const base = (): Evidence => ({ v: 1, durationMs: 100, counts: { requests: 41, requestsKept: 41, console: 0, consoleKept: 0 }, steps: [], requests: [], console: [] });
    const req = (over: Record<string, unknown>) => ({ t: 1, step: 1, method: "GET", type: "fetch", path: "/api/x", status: 200, ...over }) as Evidence["requests"][number];
    const line = (type: string, textValue: string, step = 1) => ({ t: 1, step, type, text: textValue }) as Evidence["console"][number];

    it("says what failed in the plain words of the brief", () => {
        const e = base();
        e.requests = [req({ method: "POST", path: "/api/cart?x=1", status: 500 }), req({ path: "/api/b", status: 404 }), req({ path: "/api/c", failed: "net::ERR_CONNECTION_REFUSED", status: undefined })];
        e.console = [line("error", "bad"), line("error", "worse")];
        expect(summarize(e).sentence).toBe("3 requests failed: POST /api/cart answered 500, GET /api/c could not connect and 1 more; 2 console errors; the page made 41 requests.");
    });
    it("handles one request, uncaught exceptions, cancelled requests and nothing wrong", () => {
        const one = base();
        one.requests = [req({ method: "POST", path: "/api/cart", status: 500 })];
        expect(summarize(one).sentence).toBe("1 request failed: POST /api/cart answered 500; the page made 41 requests.");
        const exc = base();
        exc.console = [line("pageerror", "TypeError: x is undefined\n   at foo")];
        exc.requests = [req({ aborted: true, failed: "net::ERR_ABORTED", status: undefined })];
        expect(summarize(exc).sentence).toBe("1 uncaught exception: “TypeError: x is undefined at foo”; 1 request was cancelled; the page made 41 requests.");
        expect(summarize(base()).sentence).toBe("No failed requests or console errors were recorded; the page made 41 requests.");
        const nothing = { ...base(), counts: { requests: 0, requestsKept: 0, console: 0, consoleKept: 0 } };
        expect(summarize(nothing).sentence).toBe("The page made no requests and wrote nothing to the console.");
    });
    it("says when the list was cut", () => {
        const e = { ...base(), counts: { requests: 1000, requestsKept: 300, console: 0, consoleKept: 0 } };
        expect(summarize(e).sentence).toContain("Only 300 of them were kept");
    });
    it("puts what happened around the failing step first, and lists slow requests", () => {
        const e = base();
        e.requests = [req({ path: "/early", status: 500, step: 1 }), req({ path: "/late", status: 500, step: 3 }), req({ path: "/missing", status: 404, step: 3 }), req({ path: "/slow", ms: 2600, step: 2 }), req({ path: "/fast", ms: 20, step: 2 })];
        e.console = [line("error", "early", 1), line("error", "late", 3), line("log", "just a log", 3)];
        const h = highlights(e, 3);
        expect(h.failed.map((r) => r.path)).toEqual(["/late", "/missing", "/early"]);
        expect(h.errors.map((l) => l.text)).toEqual(["late", "early"]);
        expect(h.slow.map((r) => r.path)).toEqual(["/slow"]);
        expect(h.nearFailure!.requests.map((r) => r.path)).toEqual(["/late", "/missing", "/slow", "/fast"]);
        expect(h.nearFailure!.console.map((l) => l.text)).toEqual(["late", "just a log"]);
        expect(highlights(e).nearFailure).toBeNull();
    });
});

describe("the generated script", () => {
    const spec = TestSpecSchema.parse({ testId: "WEB-001", title: "Home", kind: "web", category: "General", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "visible", expected: "Home" }] });
    const { content } = renderScript(spec, "playwright", { baseUrl: "http://localhost:3000" });
    it("carries the whole helper, records from the first step and attaches only through the hook", () => {
        expect(content).toContain(EVIDENCE_HELPER_SOURCE);
        expect(content).toContain("test.beforeEach(async ({ page }) => {\n    installEvidence(page, BASE_URL);");
        expect(content).toContain("await evidenceAttach(page, testInfo);");
        expect(content).toContain("evidenceStep(page, 1);\n    await test.step(");
        expect(content).toContain("evidenceStep(page, 2);");
        // on failure only: the hook returns before attaching unless the test failed
        expect(EVIDENCE_HELPER_SOURCE).toContain('if (testInfo.status === testInfo.expectedStatus && process.env.AITP_EVIDENCE !== "always") return;');
    });
    it("never reads bodies, headers or cookies", () => {
        // The one permitted read is the Content-Length of an answer; the console text is the message the page itself wrote.
        const source = EVIDENCE_HELPER_SOURCE.replace("m.text()", "m.message");
        for (const forbidden of [".body()", ".text()", ".json()", "allHeaders", "headersArray", ".cookies(", "postData"]) expect(source, forbidden).not.toContain(forbidden);
        expect(EVIDENCE_HELPER_SOURCE.match(/headers\(\)\[/g)).toHaveLength(1);
        expect(EVIDENCE_HELPER_SOURCE).toContain('res.headers()["content-length"]');
    });
    it("is plain JavaScript that compiles on its own", () => {
        expect(() => new Function(`${EVIDENCE_HELPER_SOURCE}\nreturn installEvidence;`)).not.toThrow();
        expect(EVIDENCE_HELPER_SOURCE).not.toContain("`");
    });
});

describe("issue text", () => {
    it("adds a short 'What the page did' paragraph, and nothing when there is no evidence", () => {
        const src = {
            testKey: "WEB-001",
            title: "Add to cart",
            suite: "Shop",
            spec: TestSpecSchema.parse({ testId: "WEB-001", title: "Add to cart", kind: "web", category: "Shop", steps: [{ action: "navigate", url: "/" }] }),
            validationStatus: "FAILED_VALIDATION" as const,
            reason: "It failed",
            stepResults: [],
            testUrl: "https://platform.test/#/tests/1",
        };
        const without = toMarkdown(buildIssueDraft(src).blocks);
        expect(without).not.toContain("What the page did");
        const withIt = toMarkdown(buildIssueDraft({ ...src, evidenceSummary: "1 request failed: POST /api/cart answered 500; the page made 4 requests." }).blocks);
        expect(withIt).toContain("What the page did");
        expect(withIt).toContain("1 request failed: POST /api/cart answered 500; the page made 4 requests.");
    });
});
