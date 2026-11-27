/**
 * An invariant's quoted text in the API document's own letter case (api/probes.ts documentedCasing). Re-check (main 33a3916d) shop-1
 * API-063 probed requirement 6.1 ("a new order is Placed") as `status == "Placed"`. The bench shop documents Order.status as
 * enum ["placed", "paid", "shipped", "cancelled"] and answers "placed", so the probe failed on the clean app too: a false positive.
 * The real bench-shop app on OS-assigned loopback ports; no browser, no AI.
 */
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseOpenApi } from "../src/engine/api/openapi.js";
import { documentedCasing, fetchClient, probeInvariant, type ProbeEnv } from "../src/engine/api/probes.js";
import { startBenchApp, type RunningBenchApp } from "../src/eval/bench/verify/app.js";
import type { Invariant } from "../src/engine/validation/invariants.js";

const freePort = () =>
    new Promise<number>((resolve) => {
        const srv = net.createServer().listen(0, "127.0.0.1", () => {
            const port = (srv.address() as net.AddressInfo).port;
            srv.close(() => resolve(port));
        });
    });

const ORDER = { type: "object", properties: { id: { type: "string" }, status: { type: "string", enum: ["placed", "paid", "shipped", "cancelled"] } } };

describe("documentedCasing", () => {
    it("a text the document lists only in another case becomes the listed value", () => {
        expect(documentedCasing('status == "Placed"', ORDER)).toBe('status == "placed"');
        expect(documentedCasing('$code == "SAVE10" implies status != "Shipped"', ORDER)).toBe('$code == "SAVE10" implies status != "shipped"');
    });
    it("kept: listed as written, not listed, listed in two casings, or no enum at all", () => {
        expect(documentedCasing('status == "placed"', ORDER)).toBe('status == "placed"');
        expect(documentedCasing('$code == "SAVE10"', ORDER)).toBe('$code == "SAVE10"');
        expect(documentedCasing('kind == "A"', { type: "object", properties: { kind: { type: "string", enum: ["a", "A"] } } })).toBe('kind == "A"');
        expect(documentedCasing('status == "Placed"', { type: "object", properties: { status: { type: "string" } } })).toBe('status == "Placed"');
        expect(documentedCasing('status == "Placed"', undefined)).toBe('status == "Placed"');
    });
});

// API-063 as the trial kept it: fresh account, two cart lines and an address as setup, then POST /api/orders.
describe("re-check shop-1 API-063: requirement 6.1 against the documented order status", () => {
    const inv: Invariant = { requirementId: "6.1", endpoint: "POST /api/orders", setup: ["POST /api/register", "POST /api/cart/items", "POST /api/checkout/address"], write: "POST /api/orders", expression: 'status == "Placed"' };
    let clean: RunningBenchApp;
    let seeded: RunningBenchApp;
    const envOf = async (app: RunningBenchApp): Promise<ProbeEnv> => {
        const doc = await (await fetch(`${app.base}/openapi.json`)).json();
        return { apis: parseOpenApi(doc, `${app.base}/openapi.json`).operations, dataChanges: true, newClient: async () => fetchClient(app.base) };
    };
    beforeAll(async () => {
        clean = await startBenchApp("bench-shop", await freePort(), "none");
        // Every seed of the trial on: none of them changes how an order's status is written.
        seeded = await startBenchApp("bench-shop", await freePort(), "BS-01,BS-02,BS-03,BS-04,BS-05,BS-06,BS-07,BS-08,BS-09,BS-10,BS-11,BS-12");
    });
    afterAll(async () => {
        await clean?.stop();
        await seeded?.stop();
    });
    it("on the clean app the probe holds, and the saved relation reads the documented 'placed'", async () => {
        const r = await probeInvariant(inv, await envOf(clean), { seed: 125869211 });
        expect(r.outcome).toBe("held");
        expect(r.expression).toBe('status == "placed"');
        expect(r.spec!.steps.filter((s) => s.action === "assertResponse" && s.check === "relation").map((s) => (s as { expression: string }).expression)).toEqual(['status == "placed"']);
    });
    it("on the seeded app it holds too (no seed is about the status's case)", async () => {
        expect((await probeInvariant(inv, await envOf(seeded), { seed: 125869211 })).outcome).toBe("held");
    });
});
