/**
 * Object repository, without a browser: name and locator rules, reference resolution (found / unknown / wrong kind), the
 * rule that scripts never contain a reference and are the same as for a concrete locator, usage, extraction proposals, renaming,
 * and the store on a real database (usage follows the specs, the stored form keeps the reference).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import {
    checkElement,
    collapseRefs,
    describeLocatorWords,
    indexOf,
    labelFor,
    locatorKey,
    nameProblem,
    normalizeName,
    pageFromUrl,
    proposeExtraction,
    refNames,
    renameRefs,
    resolveSpecRefs,
    scanUsage,
    tryResolveSpecRefs,
    uniqueName,
    useRefsAt,
    type ObjectIndex,
} from "../src/engine/locators/index.js";
import { describeStep, TestSpecSchema, type Locator, type TestSpec } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildBackup, restoreBackup } from "../src/platform/backup.js";
import { LocatorStore, NameTakenError } from "../src/platform/locator-store.js";

const checkout: Locator = { by: "role", role: "button", value: "Checkout", exact: true };
const web = (steps: unknown[], extra: Record<string, unknown> = {}): TestSpec => TestSpecSchema.parse({ testId: "WEB-001", title: "Buy a mug", kind: "web", category: "Shop", steps, ...extra });
const mobile = (steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: "MOB-001", title: "Buy a mug on the phone", kind: "mobile", category: "Shop", steps });
const desktop = (steps: unknown[]): TestSpec => TestSpecSchema.parse({ testId: "DSK-001", title: "Add in the calculator", kind: "desktop", desktop: { app: "calc.exe" }, category: "Calc", steps });
const objects = (...els: Array<[string, "web" | "mobile" | "desktop", Locator]>): ObjectIndex => indexOf(els.map(([name, kind, locator]) => ({ name, kind, locator })));

describe("names", () => {
    it("are normalised, then checked", () => {
        expect(normalizeName("  Cart  /   Checkout button ")).toBe("Cart / Checkout button");
        for (const ok of ["Cart / Checkout button", "Header.Search field", "A", "Page 2 - next (top)", "Café / Panier", "Buy & pay, now: yes"]) expect(nameProblem(ok), ok).toBeUndefined();
        expect(nameProblem("")).toMatch(/Give the element a name/);
        expect(nameProblem("x".repeat(81))).toMatch(/at most 80/);
        for (const bad of ["/starts with slash", "has <script>", "back`tick", "semi;colon", "new\nline", "a\\b", "{{x}}", "$(id)", "tab\tname"]) expect(nameProblem(bad), bad).toBeDefined();
    });

    it("are unique ignoring case within a project and are trimmed on input", () => {
        const c = checkElement({ name: "  Home /  Search field ", kind: "web", locator: { by: "label", value: "Search" } });
        expect(c).toMatchObject({ ok: true, element: { name: "Home / Search field" } });
    });
});

describe("elements and their locators", () => {
    const base = { name: "Thing", kind: "web" as const };
    const ok = (kind: "web" | "mobile" | "desktop", locator: unknown) => checkElement({ name: "Thing", kind, locator });

    it("accept every locator strategy a spec uses", () => {
        expect(ok("web", { by: "role", role: "button", value: "Go" })).toMatchObject({ ok: true });
        expect(ok("web", { by: "role", role: "navigation" })).toMatchObject({ ok: true });
        for (const by of ["label", "text", "placeholder", "testId", "css"] as const) expect(ok("web", { by, value: "x" }), by).toMatchObject({ ok: true });
        expect(ok("mobile", { by: "testId", value: "login", nth: 1 })).toMatchObject({ ok: true });
        expect(ok("desktop", { by: "role", role: "button", value: "Add" })).toMatchObject({ ok: true });
        expect(ok("desktop", { by: "testId", value: "btnAdd" })).toMatchObject({ ok: true });
    });

    it("refuse what a spec could not use, with a plain reason", () => {
        expect(ok("web", { by: "role", value: "Go" })).toMatchObject({ ok: false, error: expect.stringMatching(/needs the role/) });
        expect(ok("web", { by: "label" })).toMatchObject({ ok: false, error: expect.stringMatching(/needs a value/) });
        expect(ok("web", { by: "label", value: "x", role: "button" })).toMatchObject({ ok: false, error: expect.stringMatching(/Only a role locator/) });
        expect(ok("web", { by: "xpath", value: "//a" })).toMatchObject({ ok: false });
        expect(ok("web", { by: "css", value: "x".repeat(501) })).toMatchObject({ ok: false, error: expect.stringMatching(/at most 500/) });
        expect(ok("web", { by: "css", value: "a", nth: -1 })).toMatchObject({ ok: false });
        expect(ok("web", { ref: "Other" })).toMatchObject({ ok: false });
        expect(ok("desktop", { by: "css", value: "a" })).toMatchObject({ ok: false, error: expect.stringMatching(/Desktop elements can't be found by css/) });
        expect(ok("desktop", { by: "role", role: "banana" })).toMatchObject({ ok: false, error: expect.stringMatching(/control type/) });
        expect(checkElement({ ...base, locator: { by: "css", value: "a" }, notes: "n".repeat(301) })).toMatchObject({ ok: false, error: expect.stringMatching(/Notes can have at most 300/) });
        expect(checkElement({ ...base, kind: "api", locator: { by: "css", value: "a" } })).toMatchObject({ ok: false });
        expect(checkElement({ name: 5, kind: "web", locator: {} })).toMatchObject({ ok: false });
    });

    it("keep the locator tidy and drop empty page and notes", () => {
        const c = checkElement({ name: "T", kind: "web", locator: { by: "css", value: "a", exact: false, nth: 0 }, page: "  ", notes: "" });
        expect(c).toEqual({ ok: true, element: { name: "T", kind: "web", locator: { by: "css", value: "a", nth: 0 } } });
    });

    it("describe the locator in words", () => {
        expect(describeLocatorWords({ by: "role", role: "button", value: "Add to cart" })).toBe('Button "Add to cart"');
        expect(describeLocatorWords({ by: "testId", value: "checkout" })).toBe("Test id: checkout");
        expect(describeLocatorWords({ by: "label", value: "Email" })).toBe('Field labelled "Email"');
        expect(describeLocatorWords({ by: "role", role: "heading", value: "Hi", nth: 1 })).toBe('Heading "Hi", 2nd match');
        expect(describeLocatorWords({ by: "css", value: ".x" })).toBe("CSS selector: .x");
    });

    it("tell equal locators apart from different ones", () => {
        expect(locatorKey("web", { by: "css", value: "a", exact: false })).toBe(locatorKey("web", { by: "css", value: "a" }));
        expect(locatorKey("web", { by: "css", value: "a" })).not.toBe(locatorKey("mobile", { by: "css", value: "a" }));
        expect(locatorKey("web", { by: "css", value: "a" })).not.toBe(locatorKey("web", { by: "css", value: "a", nth: 0 }));
    });
});

describe("references in a spec", () => {
    const refSpec = web([
        { action: "navigate", url: "/cart" },
        { action: "click", locator: { ref: "Cart / Checkout button" } },
        { action: "assert", check: "visible", locator: { ref: "Cart / Checkout button" } },
        { action: "assert", check: "url", expected: "/pay" },
    ]);
    const index = objects(["Cart / Checkout button", "web", checkout]);

    it("are accepted by the spec schema, in any step with a locator, and nowhere else is the spec different", () => {
        expect(refSpec.steps[1]).toMatchObject({ action: "click", locator: { ref: "Cart / Checkout button" } });
        expect(refNames(refSpec)).toEqual(["Cart / Checkout button"]);
        const press = web([{ action: "press", key: "Enter", locator: { ref: "A" } }, { action: "press", key: "Tab" }]);
        expect(refNames(press)).toEqual(["A"]);
        expect(describeStep(refSpec.steps[1]!)).toBe('Click shared element "Cart / Checkout button"');
    });

    it("must be a reference or a locator, never both, and not empty", () => {
        for (const locator of [{ ref: "" }, { ref: "A", by: "css", value: "x" }, { ref: "A", value: "x" }, { ref: "x".repeat(81) }, {}]) {
            const r = TestSpecSchema.safeParse({ testId: "WEB-001", title: "Buy a mug", kind: "web", steps: [{ action: "click", locator }] });
            expect(r.success, JSON.stringify(locator)).toBe(false);
        }
        // an ordinary invalid locator still reports the missing field by name
        const r = TestSpecSchema.safeParse({ testId: "WEB-001", title: "Buy a mug", kind: "web", steps: [{ action: "click", locator: { value: "x" } }] });
        expect(r.success).toBe(false);
        if (!r.success) expect(r.error.issues[0]).toMatchObject({ path: ["steps", 0, "locator", "by"], message: "Required" });
    });

    it("resolve to the element's locator, keeping a note of where it came from", () => {
        const r = resolveSpecRefs(refSpec, index);
        expect(r.steps[1]).toMatchObject({ locator: { ...checkout, ref: "Cart / Checkout button" } });
        expect(r.steps[2]).toMatchObject({ locator: { ...checkout, ref: "Cart / Checkout button" } });
        expect(refSpec.steps[1]).toMatchObject({ locator: { ref: "Cart / Checkout button" } }); // the input is not changed
        expect(collapseRefs(r)).toEqual(refSpec);
    });

    it("are refused in plain words when the name is unknown or the element is of another kind", () => {
        expect(() => resolveSpecRefs(refSpec, undefined)).toThrow("This test refers to 'Cart / Checkout button', which is not in the object repository.");
        expect(() => resolveSpecRefs(refSpec, objects(["Other", "web", checkout]))).toThrow(/not in the object repository/);
        expect(() => resolveSpecRefs(refSpec, objects(["Cart / Checkout button", "mobile", checkout]))).toThrow("This test refers to 'Cart / Checkout button', which is a mobile element; a web test can only use web elements.");
        expect(tryResolveSpecRefs(refSpec, undefined)).toEqual({ ok: false, error: "This test refers to 'Cart / Checkout button', which is not in the object repository." });
        const two = web([{ action: "click", locator: { ref: "A" } }, { action: "click", locator: { ref: "B" } }]);
        try {
            resolveSpecRefs(two, undefined);
            expect.unreachable();
        } catch (e) {
            expect((e as { problems: string[] }).problems).toHaveLength(2);
        }
    });

    it("leave a spec without references exactly as it is (the same object)", () => {
        const plain = web([{ action: "click", locator: checkout }]);
        expect(resolveSpecRefs(plain, undefined)).toBe(plain);
        expect(resolveSpecRefs(plain, index)).toBe(plain);
        expect(collapseRefs(plain)).toBe(plain);
        expect(renameRefs(plain, "A", "B")).toBe(plain);
        expect(JSON.stringify(collapseRefs(plain))).toBe(JSON.stringify(plain));
    });

    it("are rewritten by a rename, and only the matching name", () => {
        const two = web([{ action: "click", locator: { ref: "A" } }, { action: "click", locator: { ref: "AB" } }, { action: "click", locator: { ref: "A" } }]);
        const r = renameRefs(two, "A", "New name");
        expect(refNames(r)).toEqual(["New name", "AB"]);
        expect(refNames(two)).toEqual(["A", "AB"]);
        expect(renameRefs(resolveSpecRefs(two, objects(["A", "web", checkout], ["AB", "web", checkout])), "A", "N").steps.map((s) => (s as unknown as { locator: { ref: string } }).locator.ref)).toEqual(["N", "AB", "N"]);
    });

    it("work for mobile and desktop tests too", () => {
        const m = mobile([{ action: "click", locator: { ref: "Login button" } }]);
        const dsk = desktop([{ action: "launchApp" }, { action: "click", locator: { ref: "Add" } }, { action: "closeApp" }]);
        const mScript = renderWithAdapter(m, "taqwright", { baseUrl: "https://x.example", objects: objects(["Login button", "mobile", { by: "testId", value: "login" }]) });
        expect(mScript.content).toContain('mobile.getByTestId("login")');
        expect(mScript.content).not.toContain("Login button");
        const dScript = renderWithAdapter(dsk, "windows-uia", { baseUrl: "app://x", objects: objects(["Add", "desktop", { by: "role", role: "button", value: "Add" }]) });
        expect(dScript.content).toContain('desk.click({ by: "role", value: "Add", role: "button" })');
        expect(() => renderWithAdapter(dsk, "windows-uia", { baseUrl: "app://x", objects: objects(["Add", "web", checkout]) })).toThrow(/is a web element/);
    });
});

describe("generated scripts", () => {
    const concrete = web([
        { action: "navigate", url: "/cart" },
        { action: "click", locator: checkout },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "a@b.c" },
        { action: "assert", check: "visible", locator: checkout },
        { action: "assert", check: "a11y", locator: { by: "css", value: "#cart" } },
    ]);
    const viaRefs = web([
        { action: "navigate", url: "/cart" },
        { action: "click", locator: { ref: "Checkout" } },
        { action: "fill", locator: { ref: "Email field" }, value: "a@b.c" },
        { action: "assert", check: "visible", locator: { ref: "Checkout" } },
        { action: "assert", check: "a11y", locator: { ref: "Cart area" } },
    ]);
    const index = objects(["Checkout", "web", checkout], ["Email field", "web", { by: "label", value: "Email" }], ["Cart area", "web", { by: "css", value: "#cart" }]);
    const ctx = { baseUrl: "https://shop.example" };

    it("are the same for a shared element as for the locator written out, and contain no reference", () => {
        const a = renderWithAdapter(concrete, "playwright", ctx);
        const b = renderWithAdapter(viaRefs, "playwright", { ...ctx, objects: index });
        expect(b.content).toBe(a.content);
        expect(b.filename).toBe(a.filename);
        expect(b.content).not.toMatch(/Checkout\b.*Email field|ref|shared element/i);
        expect(b.content).toContain('page.getByRole("button", { name: "Checkout", exact: true })');
        expect(b.content).toContain('page.getByLabel("Email")');
    });

    it("are refused, never rendered as something else, when a reference is not resolved", () => {
        expect(() => renderWithAdapter(viaRefs, "playwright", ctx)).toThrow("This test refers to 'Checkout', which is not in the object repository.");
        // even a generator called directly (without the platform's resolution) refuses an unresolved reference
        expect(() => renderWithAdapter(viaRefs, "playwright", { ...ctx, objects: objects(["Checkout", "web", checkout]) })).toThrow(/Email field/);
    });

    it("do not change when no reference is used: exact lines for every locator strategy", () => {
        const s = web([
            { action: "click", locator: { by: "role", role: "button", value: "Add", exact: true } },
            { action: "click", locator: { by: "label", value: "Name" } },
            { action: "click", locator: { by: "text", value: "Hi", exact: true } },
            { action: "click", locator: { by: "placeholder", value: "Find" } },
            { action: "click", locator: { by: "testId", value: "go" } },
            { action: "click", locator: { by: "css", value: ".x", nth: 2 } },
            { action: "assert", check: "text", expected: "ok" },
            { action: "press", key: "Enter" },
        ]);
        const text = renderWithAdapter(s, "playwright", ctx).content;
        for (const line of [
            'await page.getByRole("button", { name: "Add", exact: true }).click();',
            'await page.getByLabel("Name").click();',
            'await page.getByText("Hi", { exact: true }).click();',
            'await page.getByPlaceholder("Find").click();',
            'await page.getByTestId("go").click();',
            'await page.locator(".x").nth(2).click();',
            'await expect(page.locator("body")).toContainText("ok");',
            'await page.keyboard.press("Enter");',
        ]) expect(text).toContain(line);
        // and nothing about a repository appears in a script that does not use one
        expect(text).not.toMatch(/repository|shared/i);
        const again = renderWithAdapter(s, "playwright", { ...ctx, objects: index });
        expect(again.content).toBe(text);
        expect(crypto.createHash("sha256").update(text).digest("hex")).toBe(crypto.createHash("sha256").update(renderWithAdapter(JSON.parse(JSON.stringify(s)), "playwright", ctx).content).digest("hex"));
    });

    it("step titles in the script use the locator, not the name of the element", () => {
        const b = renderWithAdapter(viaRefs, "playwright", { ...ctx, objects: index }).content;
        expect(b).toContain('test.step("2. Click button \\"Checkout\\""');
        expect(b).not.toContain("Click shared element");
    });
});

describe("which tests use which element", () => {
    it("is read from the specs", () => {
        const a = web([{ action: "click", locator: { ref: "X" } }, { action: "click", locator: { ref: "X" } }, { action: "click", locator: { ref: "Y" } }]);
        const b = web([{ action: "click", locator: { ref: "X" } }]);
        const c = web([{ action: "click", locator: checkout }]);
        const usage = scanUsage([
            { id: "1", testKey: "WEB-001", title: "A", spec: a },
            { id: "2", testKey: "WEB-002", title: "B", spec: b },
            { id: "3", testKey: "WEB-003", title: "C", spec: c },
        ]);
        expect(usage.get("X")).toEqual([{ id: "1", testKey: "WEB-001", title: "A", steps: 2 }, { id: "2", testKey: "WEB-002", title: "B", steps: 1 }]);
        expect(usage.get("Y")).toHaveLength(1);
        expect([...usage.keys()].sort()).toEqual(["X", "Y"]);
    });
});

describe("extracting shared locators", () => {
    const tests = (...specs: TestSpec[]) => specs.map((spec, i) => ({ id: `id${i + 1}`, testKey: `WEB-00${i + 1}`, title: `Test ${i + 1}`, spec }));
    const add = { by: "role", role: "button", value: "Add to cart", exact: true } as const;
    const nav = (url: string) => ({ action: "navigate", url });
    const t1 = web([nav("/"), { action: "click", locator: add }, { action: "click", locator: { by: "testId", value: "checkout-btn" } }]);
    const t2 = web([nav("/"), { action: "click", locator: add }, { action: "click", locator: { by: "label", value: "Email" } }]);
    const t3 = web([nav("/cart"), { action: "click", locator: { by: "testId", value: "checkout-btn" } }, { action: "click", locator: { by: "css", value: "#only-here" } }]);

    it("finds locators spelled out identically in two or more places, most used first", () => {
        const p = proposeExtraction(tests(t1, t2, t3));
        expect(p.map((x) => x.locator)).toEqual([add, { by: "testId", value: "checkout-btn" }]);
        expect(p[0]!.uses.map((u) => `${u.testKey}#${u.stepIndex}`)).toEqual(["WEB-001#1", "WEB-002#1"]);
        expect(p[1]!.uses).toHaveLength(2);
    });

    it("skips one-offs, unless asked", () => {
        expect(proposeExtraction(tests(t1, t2, t3)).some((x) => x.locator.value === "#only-here" || x.locator.value === "Email")).toBe(false);
        const all = proposeExtraction(tests(t1, t2, t3), { minUses: 1 });
        expect(all.map((x) => x.locator.value)).toContain("#only-here");
    });

    it("names the elements from what the locator says, with the page when every use is on the same page", () => {
        const p = proposeExtraction(tests(t1, t2, t3));
        expect(p[0]!.name).toBe("Home / Add to cart button");
        expect(p[0]!.page).toBe("Home");
        // used on "/" and on "/cart": no page in the name
        expect(p[1]!.name).toBe("Checkout btn");
        expect(p[1]!.page).toBeUndefined();
        expect(labelFor({ by: "role", role: "textbox", value: "Email" })).toBe("Email field");
        expect(labelFor({ by: "label", value: "Email" })).toBe("Email field");
        expect(labelFor({ by: "text", value: "Welcome" })).toBe("Welcome text");
        expect(labelFor({ by: "testId", value: "nav-menuOpen" })).toBe("Nav menu open");
        expect(labelFor({ by: "role", role: "button" })).toBe("Unnamed button");
        expect(pageFromUrl("/")).toBe("Home");
        expect(pageFromUrl("/shop/cart?x=1")).toBe("Shop cart");
        expect(pageFromUrl("/p/{{id}}")).toBeUndefined();
    });

    it("makes every name valid and unique, also against existing elements and against each other", () => {
        const dup = (value: string) => web([nav("/"), { action: "click", locator: { by: "role", role: "button", value } }]);
        // two different locators that would get the same name
        const a1 = web([nav("/"), { action: "click", locator: { by: "role", role: "button", value: "Go" } }, { action: "click", locator: { by: "role", role: "button", value: "Go", nth: 1 } }]);
        const a2 = web([nav("/"), { action: "click", locator: { by: "role", role: "button", value: "Go" } }, { action: "click", locator: { by: "role", role: "button", value: "Go", nth: 1 } }]);
        const p = proposeExtraction(tests(a1, a2), { existing: [{ name: "Home / go button", kind: "web", locator: { by: "css", value: "z" } }] });
        const names = p.map((x) => x.name);
        expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
        expect(names).toContain("Home / Go button 2");
        for (const n of names) expect(nameProblem(n), n).toBeUndefined();
        void dup;
        expect(uniqueName("A <b> / c", new Set())).toBe("A b / c");
        expect(uniqueName("x".repeat(200), new Set()).length).toBeLessThanOrEqual(80);
        expect(nameProblem(uniqueName("%%%", new Set()))).toBeUndefined();
    });

    it("points at an existing element when its locator is identical, and never proposes a locator that depends on test data", () => {
        const p = proposeExtraction(tests(t1, t2), { existing: [{ name: "Shop / Add", kind: "web", locator: add }] });
        expect(p[0]).toMatchObject({ name: "Shop / Add", existing: "Shop / Add" });
        const dataDriven = web([{ action: "click", locator: { by: "text", value: "Item {{n}}" } }]);
        expect(proposeExtraction(tests(dataDriven, dataDriven))).toEqual([]);
    });

    it("keeps web, mobile and desktop apart and skips what already is a reference", () => {
        const w = web([{ action: "click", locator: { by: "testId", value: "go" } }]);
        const m = mobile([{ action: "click", locator: { by: "testId", value: "go" } }]);
        expect(proposeExtraction(tests(w, m))).toEqual([]);
        expect(proposeExtraction(tests(w, m, mobile([{ action: "click", locator: { by: "testId", value: "go" } }]))).map((x) => x.kind)).toEqual(["mobile"]);
        const r = web([{ action: "click", locator: { ref: "Go" } }]);
        expect(proposeExtraction(tests(r, r))).toEqual([]);
    });

    it("applying a choice only changes the steps it names", () => {
        const p = proposeExtraction(tests(t1, t2))[0]!;
        const names = new Map(p.uses.filter((u) => u.testKey === "WEB-001").map((u) => [u.stepIndex, p.name]));
        const changed = useRefsAt(t1, names);
        expect(refNames(changed)).toEqual([p.name]);
        expect(changed.steps[2]).toEqual(t1.steps[2]);
        expect(changed.steps[0]).toBe(t1.steps[0]);
        expect(collapseRefs(resolveSpecRefs(changed, objects([p.name, "web", add])))).toEqual(changed);
    });
});

describe("the store", () => {
    let dir: string;
    let platform: Platform;
    let store: LocatorStore;
    let projectA: string;
    let projectB: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-locators-unit-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "test-secret-key-0123456789" }));
        store = new LocatorStore(platform.db);
        projectA = platform.repo.createProject({ name: "A" }).id as string;
        projectB = platform.repo.createProject({ name: "B" }).id as string;
    });
    afterAll(() => {
        platform?.db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const insert = (projectId: string, spec: TestSpec) => {
        const suite = platform.repo.getOrCreateSuite(projectId, "Shop", "shop");
        return platform.repo.insertTest({ projectId, suiteId: suite, jobId: null, spec, framework: "playwright", validationStatus: "PENDING" });
    };

    it("keeps names unique per project ignoring case, and projects apart", () => {
        const a = store.create(projectA, { name: "Cart / Checkout button", kind: "web", locator: checkout });
        expect(a).toMatchObject({ version: 1, kind: "web", page: null, notes: null, locator: checkout });
        expect(() => store.create(projectA, { name: "cart / CHECKOUT button", kind: "web", locator: checkout })).toThrow(NameTakenError);
        expect(store.create(projectB, { name: "Cart / Checkout button", kind: "web", locator: { by: "css", value: "#b" } }).projectId).toBe(projectB);
        expect(store.get(projectB, a.id)).toBeUndefined();
        expect(store.getByName(projectA, "Cart / Checkout button")?.id).toBe(a.id);
        expect(store.getByName(projectA, "cart / checkout button")).toBeUndefined(); // references use the exact name
        expect(store.index(projectA)?.get("Cart / Checkout button")).toEqual({ kind: "web", locator: checkout });
        expect(store.index(platform.repo.createProject({ name: "Empty" }).id as string)).toBeUndefined();
    });

    it("bumps the version on every change, and refuses a name that is taken", () => {
        const e = store.create(projectA, { name: "Search field", kind: "web", locator: { by: "label", value: "Search" } });
        const u = store.update(projectA, e.id, { locator: { by: "placeholder", value: "Find" }, notes: "moved" });
        expect(u).toMatchObject({ version: 2, notes: "moved", locator: { by: "placeholder", value: "Find" } });
        expect(() => store.update(projectA, e.id, { name: "cart / checkout BUTTON" })).toThrow(NameTakenError);
        expect(store.update(projectA, e.id, { name: "Search box" }).name).toBe("Search box");
    });

    it("follows the specs: usage appears when a spec with a reference is stored and goes when it is edited or the test removed", () => {
        const el = store.getByName(projectA, "Cart / Checkout button")!;
        const t1 = insert(projectA, web([{ action: "click", locator: { ref: "Cart / Checkout button" } }, { action: "click", locator: { ref: "Cart / Checkout button" } }]));
        const t2 = insert(projectA, web([{ action: "click", locator: { ref: "Cart / Checkout button" } }], { testId: "WEB-002" }));
        insert(projectA, web([{ action: "click", locator: checkout }], { testId: "WEB-003" }));
        expect(store.usersOf(el.id).map((u) => [u.testKey, u.steps])).toEqual([["WEB-001", 2], ["WEB-002", 1]]);
        expect(store.usersByElement(projectA).get(el.id)).toHaveLength(2);
        expect(store.usedByTest(projectA, t1).map((e) => e.name)).toEqual(["Cart / Checkout button"]);
        // another project's elements are not mixed in
        expect(store.usersByElement(projectB).size).toBe(0);

        platform.repo.updateTest(t2, { spec: web([{ action: "click", locator: checkout }], { testId: "WEB-002" }) });
        expect(store.usersOf(el.id).map((u) => u.testKey)).toEqual(["WEB-001"]);
        platform.db.run("DELETE FROM test_cases WHERE id = ?", t1);
        expect(store.usersOf(el.id)).toEqual([]);
    });

    it("stores the reference, never a copy of the locator, when the engine saves a resolved spec", () => {
        const el = store.getByName(projectA, "Cart / Checkout button")!;
        const refSpec = web([{ action: "navigate", url: "/" }, { action: "click", locator: { ref: el.name } }], { testId: "WEB-010" });
        const id = insert(projectA, refSpec);
        const resolved = resolveSpecRefs(platform.repo.getTest(id)!.spec, store.index(projectA));
        expect(JSON.stringify(resolved)).toContain('"by":"role"');
        platform.repo.updateTest(id, { spec: resolved, validationStatus: "VALIDATED" });
        expect(platform.repo.getTest(id)!.spec).toEqual(refSpec);
        expect(store.usersOf(el.id).map((u) => u.testKey)).toContain("WEB-010");
        // a step the engine changed on its own is stored as it is
        const changed = { ...resolved, steps: resolved.steps.map((s, i) => (i === 1 ? { ...s, locator: { by: "css", value: "#new" } } : s)) } as TestSpec;
        platform.repo.updateTest(id, { spec: changed });
        expect(platform.repo.getTest(id)!.spec.steps[1]).toMatchObject({ locator: { by: "css", value: "#new" } });
        expect(store.usersOf(el.id).map((u) => u.testKey)).not.toContain("WEB-010");
    });

    it("stores a spec without references exactly as before", () => {
        const plain = web([{ action: "navigate", url: "/" }, { action: "click", locator: checkout }], { testId: "WEB-011" });
        const id = insert(projectA, plain);
        platform.repo.updateTest(id, { spec: plain });
        const row = platform.db.get<{ spec_json: string }>("SELECT spec_json FROM test_cases WHERE id = ?", id)!;
        expect(row.spec_json).toBe(JSON.stringify(plain));
    });

    it("travels with a project backup: tests and the elements they refer to are restored together", async () => {
        const src = platform.repo.createProject({ name: "Backed up" }).id as string;
        platform.repo.createApplication(src, "http://127.0.0.1:5931", {});
        const el = store.create(src, { name: "Backup / Go", kind: "web", locator: { by: "testId", value: "go" }, page: "Backup", notes: "n" });
        insert(src, web([{ action: "click", locator: { ref: "Backup / Go" } }], { testId: "WEB-020" }));
        const { bytes } = await buildBackup(platform, src, { evidence: false, maxEvidenceMB: 0 });
        const restored = await restoreBackup(platform, bytes, { name: "Restored copy" });
        const pid = restored.project.id;
        const copy = store.list(pid);
        expect(copy.map((e) => [e.name, e.page, e.notes, e.locator])).toEqual([["Backup / Go", "Backup", "n", { by: "testId", value: "go" }]]);
        expect(copy[0]!.id).not.toBe(el.id);
        expect(store.usersOf(copy[0]!.id).map((u) => u.testKey)).toEqual(["WEB-020"]);
        // a project without elements makes a backup with no objects file
        const bare = platform.repo.createProject({ name: "Bare" }).id as string;
        const b = await buildBackup(platform, bare, { evidence: false, maxEvidenceMB: 0 });
        expect(Object.keys((await import("fflate")).unzipSync(b.bytes))).not.toContain("objects.json");
    });

    it("rebuilds the usage of a project from its specs", () => {
        const el = store.create(projectA, { name: "Rebuilt", kind: "web", locator: { by: "css", value: "#r" } });
        const id = insert(projectA, web([{ action: "click", locator: { ref: "Rebuilt" } }], { testId: "WEB-012" }));
        platform.db.run("DELETE FROM locator_usage");
        expect(store.usersOf(el.id)).toEqual([]);
        store.rebuildProject(projectA);
        expect(store.usersOf(el.id).map((u) => u.testKey)).toEqual(["WEB-012"]);
        expect(id).toBeTruthy();
    });
});
