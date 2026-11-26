/**
 * `bench --dirty-start` (CP-F): every start and reset of a bench app leaves Wave 0's leftovers in the explored account, also with every
 * seed on. Starts the apps on loopback ports 7690-7691 and stops them by their own handle.
 */
import { afterEach, describe, expect, it } from "vitest";
import { benchApp, BenchAppHost, type Switches } from "../src/eval/bench/apps.js";
import { parseBenchArgs } from "../src/eval/bench/cli.js";

let host: BenchAppHost | undefined;
afterEach(async () => {
    await host?.stop();
    host = undefined;
});

async function signedIn(url: string, email: string) {
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Password1!" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    return async (p: string) => (await fetch(`${url}${p}`, { headers: { cookie } })).json() as Promise<any>;
}

describe("--dirty-start", () => {
    it("is parsed, and --data-changes-off refuses --allow-data-changes", () => {
        expect(parseBenchArgs(["--dirty-start"]).dirtyStart).toBe(true);
        expect(parseBenchArgs([]).dirtyStart).toBeUndefined();
        expect(parseBenchArgs(["--data-changes-off"]).dataChangesOff).toBe(true);
        expect(() => parseBenchArgs(["--data-changes-off", "--max"])).toThrow(/cannot be combined/);
    });

    for (const switches of ["none", "all"] as Switches[]) {
        it(`bench-shop (${switches}): an earlier order, three cart lines and SAVE10, after a start and after a reset`, async () => {
            host = new BenchAppHost(benchApp("bench-shop")!, 7690, undefined, "html", undefined, true);
            await host.start(switches);
            for (const when of ["start", "reset"]) {
                if (when === "reset") await host.reset();
                const get = await signedIn(host.url, "alice@example.test");
                const cart = await get("/api/cart");
                // With every seed on, a seed keeps the ordered line in the cart too, and BS-12 hides the newest order from the list.
                if (switches === "none") expect(cart.lines.length, when).toBe(3);
                else expect(cart.lines.length, when).toBeGreaterThanOrEqual(3);
                expect(cart.discount, when).toBeGreaterThan(0);
                expect((await get("/api/orders")).orders.length, when).toBeGreaterThanOrEqual(switches === "none" ? 2 : 1);
            }
        }, 60_000);
    }

    it("bench-rbac: a leftover note; without the option the app starts clean", async () => {
        host = new BenchAppHost(benchApp("bench-rbac")!, 7691, undefined, "html", undefined, true);
        await host.start("none");
        const notes = async () => ((await (await signedIn(host!.url, "ana@example.test"))("/api/notes")).notes as Array<{ title: string }>).map((n) => n.title);
        expect(await notes()).toContain("Leftover note");
        await host.stop();
        host = new BenchAppHost(benchApp("bench-rbac")!, 7691);
        await host.start("none");
        expect(await notes()).not.toContain("Leftover note");
    }, 60_000);
});
