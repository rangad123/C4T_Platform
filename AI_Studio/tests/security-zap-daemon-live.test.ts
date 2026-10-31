/**
 * The ZAP adapter against a REAL running ZAP daemon - not a stand-in for one.
 *
 * Every other ZAP test fakes `fetchJson`. That proves the adapter's own logic but not one thing about ZAP: not that the API answers, not
 * what it does with a wrong key, not what a real passive scan returns, and not whether the adapter can be stopped while it runs. Those
 * are the questions that were wrong for a long time in this module, so they are asked here of an actual daemon.
 *
 * Skipped unless both are present, because a test that quietly pretends a daemon answered is worse than no test:
 *   SECURITY_ZAP_URL=http://127.0.0.1:8090
 *   SECURITY_ZAP_API_KEY=<that daemon's key>
 *   SECURITY_ZAP_TARGET_URL=http://127.0.0.1:5310   (something ZAP may scan; examples/security-fixture/server.mjs 5310)
 */
import { afterAll, describe, expect, it } from "vitest";
import { scannerSettings } from "../src/security/scanners/settings.js";
import { ZapAdapter } from "../src/security/scanners/zap/adapter.js";
import type { ScanTarget } from "../src/security/scanners/contract.js";

const ZAP_URL = process.env.SECURITY_ZAP_URL;
const ZAP_KEY = process.env.SECURITY_ZAP_API_KEY;
const TARGET = process.env.SECURITY_ZAP_TARGET_URL;
const ready = Boolean(ZAP_URL && ZAP_KEY && TARGET);
const describeIf = ready ? describe : describe.skip;

const adapterFor = (over: { url?: string; key?: string; minutes?: string } = {}) =>
    new ZapAdapter({
        settings: scannerSettings({
            SECURITY_SCANNERS: "zap",
            SECURITY_ZAP_URL: over.url ?? ZAP_URL!,
            SECURITY_ZAP_API_KEY: over.key ?? ZAP_KEY!,
            ...(over.minutes ? { SECURITY_SCANNER_MAX_MINUTES: over.minutes } : {}),
        }),
    });

const targetFor = (urls: string[], over: Partial<ScanTarget> = {}): ScanTarget => ({
    applicationId: "live-zap",
    origin: TARGET!,
    urls,
    excludedPaths: [],
    maxRequestsPerSecond: 3,
    requestBudget: 500,
    timeoutMs: 120_000,
    ...over,
});

describeIf("the ZAP adapter against a real daemon", () => {
    afterAll(() => {
        /* the daemon belongs to the operator; this file never stops it */
    });

    it("reaches the daemon and reads its real version", async () => {
        const state = await adapterFor().available();
        expect(state.state, `ZAP was not reachable at ${ZAP_URL}: ${state.reason ?? ""} ${state.remedy ?? ""}`).toBe("available");
        expect(state.version).toMatch(/^\d+\.\d+/);
    });

    it("says plainly when nothing is listening, rather than blaming the key", async () => {
        const down = await adapterFor({ url: "http://127.0.0.1:8099" }).available();
        expect(down.state).toBe("unavailable");
        expect(down.reason).toMatch(/could not be reached/);
        expect(down.remedy, "a daemon that is not running must not send the operator to the API key").not.toMatch(/SECURITY_ZAP_API_KEY/);
    });

    it("names both causes when the daemon hangs up, and puts the key first", async () => {
        // Verified on 2.17.0: a wrong key and a closed API are the same closed socket, so the adapter cannot pick one and must not.
        const wrongKey = await adapterFor({ key: "definitely-not-the-key-000000000000" }).available();
        expect(wrongKey.state).toBe("unavailable");
        expect(wrongKey.reason).toMatch(/closed the connection without answering/);
        expect(wrongKey.remedy).toMatch(/API key FIRST/);
        expect(wrongKey.remedy).toMatch(/NOT -config api\.addrs/);
    });

    it("recognises an address that answers but is not ZAP", async () => {
        const notZap = await adapterFor({ url: TARGET! }).available();
        expect(notZap.state).not.toBe("available");
        expect(`${notZap.reason ?? ""} ${notZap.remedy ?? ""}`).toMatch(/SECURITY_ZAP_URL|core\/view\/version|not a version/i);
    });

    it("runs a real passive scan and reports only the addresses it was given", async () => {
        const adapter = adapterFor();
        const handle = await adapter.start(targetFor([TARGET!]), "passive", { signal: new AbortController().signal, approval: null });
        try {
            const out = await handle.results();
            expect(out.findings.length, "a real passive scan of a header-less fixture must raise alerts").toBeGreaterThan(0);
            for (const f of out.findings) {
                expect(f.scannerRuleId, "a finding keeps ZAP's own rule id").toMatch(/^(zap:)?\d+$/);
                expect(f.url).toBeTruthy();
                // Only the address this run was given. ZAP answers with its whole alert table otherwise.
                expect(f.url.startsWith(TARGET!), `${f.url} is not the address this run was given`).toBe(true);
            }
            // The coverage has to be honest about what was not looked at, or the report overstates the scan.
            expect(out.coverage.notInspected.join(" ")).toMatch(/does not look for|passive rules/i);
        } finally {
            await handle.cleanup();
        }
    }, 180_000);

    it("cancels a run that is genuinely in flight, and leaves the daemon as it was found", async () => {
        // Against the fast fixture a passive scan finishes in about two seconds, so cancelling "immediately" would be racing a run that
        // has already ended and would prove nothing. The fixture's /slow route holds the request open, so the abort lands mid-scan.
        const adapter = adapterFor();
        const before = await adapter.available();
        const controller = new AbortController();
        // `start()` is eager: it runs the scan to the end before it hands back a handle, so the abort has to be armed BEFORE it is
        // awaited. Awaiting it first would let the whole scan finish and then cancel nothing.
        const started = adapter.start(targetFor([`${TARGET}/slow?ms=60000`]), "passive", { signal: controller.signal, approval: null });
        await new Promise((r) => setTimeout(r, 2_000));
        controller.abort();
        await expect(started, "a cancelled run must fail rather than report a result as if it had finished").rejects.toThrow(/cancel/i);
        const after = await adapter.available();
        expect(after.state, "the daemon must be usable again after a cancelled run").toBe("available");
        expect(after.version).toBe(before.version);
    }, 120_000);

    it("abandons a run part-way the way a time limit abandons it, without stranding the daemon", async () => {
        // ZAP's API has no "stop after N seconds", and the adapter quantises its run limit to whole minutes, so the wall-clock limit
        // itself is covered by unit tests with a controlled clock rather than here. What a live daemon can prove - and what actually
        // bites an operator - is that a run dropped mid-flight leaves the daemon clean and reusable.
        const adapter = adapterFor();
        const controller = new AbortController();
        const started = adapter.start(targetFor([`${TARGET}/slow?ms=60000`]), "passive", { signal: controller.signal, approval: null });
        await new Promise((r) => setTimeout(r, 2_000));
        controller.abort();
        await started.catch(() => undefined);
        expect((await adapter.available()).state, "the daemon must survive a dropped run").toBe("available");
    }, 120_000);
});