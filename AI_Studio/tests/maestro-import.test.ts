/**
 * Maestro flow import: the converter (every supported and unsupported command, reporting, caps, unsafe YAML), the scripts
 * the converted specs render to (they must be valid TypeScript against Taqwright's real types), and the import route
 * (dry run, storing through the spec-import path, refusals). Starts no browser: pure converter + `server.inject`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { renderScript } from "../src/engine/generators/index.js";
import { convertMaestroFlow, convertMaestroFlows, MaestroSyntaxError, type FlowReport } from "../src/engine/import/maestro.js";
import { TestSpecSchema } from "../src/engine/spec/schema.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { buildServer } from "../src/platform/server.js";

const PW_SENTINEL = "MAESTRO-Sentinel-Pw-4f81c2";

const LOGIN = `appId: com.example.shop
name: Sign in with a saved account
tags:
  - smoke
env:
  PASSWORD: ${PW_SENTINEL}
---
- launchApp
- tapOn: "Email"
- inputText: "\${EMAIL}"
- tapOn:
    id: password_field
- inputText: "\${PASSWORD}"
- hideKeyboard
- tapOn: "Sign in"
- waitForAnimationToEnd
- assertVisible: "Welcome back"
- assertNotVisible: "Invalid password"
- scroll
- scrollUntilVisible:
    element:
      text: "Order history"
- swipe:
    direction: LEFT
- back
- pressKey: Enter
- pressKey: Home
`;

const convert = (content: string, name = "flow.yaml"): FlowReport => convertMaestroFlow({ name, content });
const flow = (commands: string, header = "appId: com.example.shop") => `${header}\n---\n${commands}\n- assertVisible: "Done"\n`;
const stepsOf = (r: FlowReport) => r.spec?.steps ?? [];

describe("converting a real-looking login flow", () => {
    const r = convert(LOGIN, "login.yaml");

    it("becomes a mobile spec with the supported steps, in order", () => {
        expect(r.status).toBe("converted");
        expect(r).toMatchObject({ kind: "mobile", appId: "com.example.shop", title: "Sign in with a saved account", checks: 2 });
        expect(r.spec).toMatchObject({ kind: "mobile", category: "Imported from Maestro", source: { origin: "imported" }, tags: ["maestro", "smoke"] });
        expect(stepsOf(r).map((s) => (s.action === "assert" ? `assert ${s.check}` : s.action === "press" ? `press ${s.key}` : s.action))).toEqual([
            "click",
            "fill",
            "click",
            "fill",
            "click",
            "wait",
            "assert visible",
            "assert hidden",
            "press device:scroll:down",
            "press device:scroll-into-view",
            "press device:swipe:left",
            "press device:back",
            "press Enter",
            "press device:home",
        ]);
        expect(stepsOf(r)[2]).toMatchObject({ action: "click", locator: { by: "testId", value: "password_field" } });
    });

    it("maps variables to placeholders and never copies a value", () => {
        expect(stepsOf(r)[1]).toMatchObject({ action: "fill", value: "{{credentials.username}}" });
        expect(stepsOf(r)[3]).toMatchObject({ action: "fill", value: "{{credentials.password}}" });
        expect(r.variables).toEqual(expect.arrayContaining([{ name: "EMAIL", placeholder: "{{credentials.username}}" }, { name: "PASSWORD", placeholder: "{{credentials.password}}" }]));
        expect(JSON.stringify(r)).not.toContain(PW_SENTINEL);
        expect(r.notes.some((n) => n.command === "env" && /not copied/.test(n.reason))).toBe(true);
    });

    it("reports what it could not convert, with the step number and why", () => {
        expect(r.notes.filter((n) => n.level === "skipped")).toEqual([{ step: 6, command: "hideKeyboard", level: "skipped", reason: "This command is not supported by the importer yet." }]);
    });

    it("is a valid spec", () => {
        expect(TestSpecSchema.safeParse({ ...r.spec, testId: "MOB-001" }).success).toBe(true);
    });
});

describe("the conversion table: supported commands", () => {
    const cases: Array<[string, string, (r: FlowReport) => void]> = [
        ["tapOn text", "- tapOn: Log in", (r) => expect(stepsOf(r)[0]).toMatchObject({ action: "click", locator: { by: "text", value: "Log in" } })],
        ["tapOn text with index", "- tapOn:\n    text: Item\n    index: 2", (r) => expect(stepsOf(r)[0]).toMatchObject({ locator: { by: "text", value: "Item", nth: 2 } })],
        ["tapOn id", "- tapOn:\n    id: btn_ok", (r) => expect(stepsOf(r)[0]).toMatchObject({ locator: { by: "testId", value: "btn_ok" } })],
        ["inputText after a tap", "- tapOn: Name\n- inputText: Ada", (r) => expect(stepsOf(r)[1]).toMatchObject({ action: "fill", value: "Ada", locator: { by: "text", value: "Name" } })],
        ["assertVisible", '- assertVisible: "Hello"', (r) => expect(stepsOf(r)[0]).toMatchObject({ action: "assert", check: "visible", locator: { by: "text", value: "Hello" } })],
        ["assertNotVisible", '- assertNotVisible:\n    id: spinner', (r) => expect(stepsOf(r)[0]).toMatchObject({ action: "assert", check: "hidden", locator: { by: "testId", value: "spinner" } })],
        ["scroll", "- scroll", (r) => expect(stepsOf(r)[0]).toMatchObject({ action: "press", key: "device:scroll:down" })],
        ["scrollUntilVisible", "- scrollUntilVisible:\n    element: Footer", (r) => expect(stepsOf(r)[0]).toMatchObject({ key: "device:scroll-into-view", locator: { by: "text", value: "Footer" } })],
        ["back", "- back", (r) => expect(stepsOf(r)[0]).toMatchObject({ key: "device:back" })],
        ["pressKey Enter", "- pressKey: Enter", (r) => expect(stepsOf(r)[0]).toMatchObject({ key: "Enter" })],
        ["swipe direction", "- swipe:\n    direction: UP", (r) => expect(stepsOf(r)[0]).toMatchObject({ key: "device:swipe:up" })],
        ["waitForAnimationToEnd", "- waitForAnimationToEnd", (r) => expect(stepsOf(r)[0]).toMatchObject({ action: "wait", ms: 1000 })],
        ["waitForAnimationToEnd with a timeout", "- waitForAnimationToEnd:\n    timeout: 99999", (r) => expect(stepsOf(r)[0]).toMatchObject({ action: "wait", ms: 10000 })],
        ["launchApp needs no step", "- launchApp", (r) => expect(stepsOf(r)).toHaveLength(1)],
        ["inline runFlow is flattened", "- runFlow:\n    commands:\n      - tapOn: A\n      - tapOn: B", (r) => expect(stepsOf(r).map((s) => (s.action === "click" ? s.locator.value : s.action))).toEqual(["A", "B", "assert"])],
    ];
    it.each(cases)("%s", (_name, commands, check) => {
        const r = convert(flow(commands));
        expect(r.status).toBe("converted");
        expect(r.notes.filter((n) => n.level === "skipped")).toEqual([]);
        check(r);
    });
});

describe("the conversion table: unsupported commands are reported per step", () => {
    const cases: Array<[string, string, RegExp]> = [
        ["tapOn a point", '- tapOn:\n    point: "50%,50%"', /screen position/],
        ["tapOn optional", "- tapOn:\n    text: Maybe\n    optional: true", /Optional/],
        ["tapOn below another element", "- tapOn:\n    text: Edit\n    below: Name", /“below”/],
        ["tapOn without a selector", "- tapOn:\n    index: 1", /needs an element/],
        ["inputText with no field tapped first", "- inputText: lonely", /focused/],
        ["swipe between points", '- swipe:\n    start: "90%, 50%"\n    end: "10%, 50%"', /direction/],
        ["pressKey Volume Up", "- pressKey: Volume Up", /not supported/],
        ["runFlow from a file", "- runFlow: other.yaml", /another flow file/],
        ["runFlow with a condition", "- runFlow:\n    when:\n      visible: Popup\n    commands:\n      - tapOn: Close", /condition/],
        ["repeat", "- repeat:\n    times: 3\n    commands:\n      - back", /Repeating/],
        ["runScript", "- runScript: setup.js", /never run/],
        ["evalScript", "- evalScript: ${output.x = 1}", /never run/],
        ["openLink", "- openLink: https://example.com", /link/],
        ["takeScreenshot", "- takeScreenshot: shot", /not supported/],
        ["a script expression in text", '- tapOn: "${1 + 1}"', /script expression/],
    ];
    it.each(cases)("%s", (_name, commands, reason) => {
        const r = convert(flow(commands));
        expect(r.status).toBe("converted"); // the closing assertion still converts
        const skipped = r.notes.filter((n) => n.level === "skipped");
        expect(skipped).toHaveLength(1);
        expect(skipped[0]!.step).toBe(1);
        expect(skipped[0]!.reason).toMatch(reason);
        // a skipped command adds nothing to the test
        expect(stepsOf(r)).toHaveLength(1);
    });
});

describe("whole flows that are not imported, with the reason", () => {
    it("a flow with no convertible check", () => {
        const r = convert("appId: com.example.shop\n---\n- launchApp\n- tapOn: Start\n- takeScreenshot: x\n");
        expect(r).toMatchObject({ status: "skipped", checks: 0 });
        expect(r.reason).toMatch(/never verify/);
        expect(r.notes).toHaveLength(1);
        expect(r.spec).toBeUndefined();
    });
    it.each([
        ["no header", '- tapOn: A\n- assertVisible: "B"\n'.replace("- tapOn: A\n", "").replace("- assertVisible", "- assertVisible"), /neither an app/],
    ])("%s", (_n, content) => {
        // a bare command list has no appId or url
        expect(convert(content)).toMatchObject({ status: "skipped" });
        expect(convert(content).reason).toMatch(/neither an app/);
    });
    it("both appId and url", () => expect(convert('appId: com.a.b\nurl: https://x.test\n---\n- assertVisible: "a"\n').reason).toMatch(/both/));
    it("an application id that is not one", () => expect(convert('appId: "not an id"\n---\n- assertVisible: "a"\n').reason).toMatch(/not an application id/));
    it("a web address with a variable", () => expect(convert('url: "https://${HOST}/"\n---\n- assertVisible: "a"\n').reason).toMatch(/without variables/));
    it("the workspace configuration file", () => expect(convert("flows:\n  - '*'\n", "config.yaml").reason).toMatch(/workspace configuration/));
    it("a header without commands", () => expect(convert("appId: com.a.b\n").reason).toMatch(/not a Maestro flow/));
    it("an empty file", () => expect(convert("").reason).toMatch(/empty/));
    it("a file that is not yaml by name", () => expect(convert("appId: a.b", "notes.txt").reason).toMatch(/Only \.yaml/));
});

describe("web flows (a url header)", () => {
    const r = convert(`url: https://shop.example.test/start\nname: Search works\n---\n- launchApp\n- tapOn: Search\n- inputText: shoes\n- pressKey: Enter\n- scroll\n- back\n- assertVisible:\n    id: results\n`);
    it("start on the url and use web equivalents", () => {
        expect(r).toMatchObject({ status: "converted", kind: "web", url: "https://shop.example.test/start" });
        expect(stepsOf(r).map((s) => (s.action === "navigate" ? `navigate ${s.url}` : s.action === "press" ? `press ${s.key}` : s.action === "assert" ? `assert ${s.locator?.by}:${s.locator?.value}` : s.action))).toEqual([
            "navigate https://shop.example.test/start",
            "click",
            "fill",
            "press Enter",
            "press PageDown",
            "assert css:#results",
        ]);
        expect(r.notes).toEqual([{ step: 6, command: "back", level: "skipped", reason: "The browser’s Back button is not available in web tests yet." }]);
        expect(r.convertedSteps).toBe(5);
    });
    it("renders a Playwright script", () => {
        const spec = TestSpecSchema.parse({ ...r.spec, testId: "WEB-001" });
        const script = renderScript(spec, "playwright", { baseUrl: "https://shop.example.test" }).content;
        expect(script).toContain("page.keyboard.press(\"PageDown\")");
        expect(script).toContain("shop.example.test/start");
    });
});

describe("variables", () => {
    it("map to credentials or to environment variables, and expressions are refused", () => {
        const r = convert(flow('- tapOn: "Hello ${USERNAME}"\n- tapOn: "Region ${REGION}"\n- tapOn: "${a.b}"'));
        expect(r.variables).toEqual([
            { name: "USERNAME", placeholder: "{{credentials.username}}" },
            { name: "REGION", placeholder: "{{env.REGION}}" },
        ]);
        expect(stepsOf(r)[1]).toMatchObject({ locator: { value: "Region {{env.REGION}}" } });
        expect(r.notes.filter((n) => n.level === "skipped").map((n) => n.step)).toEqual([3]);
    });
    it("render as environment reads in the script, never as values", () => {
        const r = convert(LOGIN, "login.yaml");
        const script = renderScript(TestSpecSchema.parse({ ...r.spec, testId: "MOB-001" }), "taqwright", { baseUrl: "android-app://com.example.shop" }).content;
        expect(script).toContain("process.env.TEST_PASSWORD");
        expect(script).toContain("process.env.TEST_USERNAME");
        expect(script).not.toContain(PW_SENTINEL);
    });
});

describe("a batch", () => {
    it("imports flows for one app and skips the others with the reason", () => {
        const { reports } = convertMaestroFlows([
            { name: "a.yaml", content: flow("- tapOn: A") },
            { name: "b.yaml", content: flow("- tapOn: B", "appId: com.other.app") },
            { name: "c.yaml", content: flow("- tapOn: C", "url: https://x.example.test/") },
            { name: "d.yaml", content: flow("- tapOn: D") },
        ]);
        expect(reports.map((r) => r.status)).toEqual(["converted", "skipped", "skipped", "converted"]);
        expect(reports[1]!.reason).toMatch(/com\.other\.app.*separate batch/);
        expect(reports[2]!.reason).toMatch(/x\.example\.test.*separate batch/);
        expect(reports[1]!.spec).toBeUndefined();
    });
    it("caps the number of flows and the size of a file", () => {
        expect(() => convertMaestroFlows(Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.yaml`, content: flow("- back") })))).toThrow(/at most 100/);
        expect(convertMaestroFlows(Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.yaml`, content: flow("- back") }))).reports).toHaveLength(100);
        const big = convert(`${flow("- back")}# ${"x".repeat(201 * 1024)}\n`);
        expect(big).toMatchObject({ status: "skipped" });
        expect(big.reason).toMatch(/larger than 200 KB/);
    });
    it("collects unreadable files instead of stopping at the first", () => {
        const { reports, syntaxErrors } = convertMaestroFlows([
            { name: "ok.yaml", content: flow("- back") },
            { name: "bad1.yaml", content: "appId: [unclosed\n---\n- back" },
            { name: "bad2.yaml", content: "- tapOn: {a: 1\n" },
        ]);
        expect(reports).toHaveLength(1);
        expect(syntaxErrors.map((e) => e.file)).toEqual(["bad1.yaml", "bad2.yaml"]);
        expect(syntaxErrors[0]).toBeInstanceOf(MaestroSyntaxError);
    });
});

describe("unsafe YAML is refused, not executed", () => {
    it("custom tags", () => {
        expect(() => convert("appId: com.a.b\n---\n- tapOn: !!js/function 'function(){ process.exit(1) }'\n")).toThrow(MaestroSyntaxError);
        expect(() => convert("appId: !custom com.a.b\n---\n- back\n")).toThrow(MaestroSyntaxError);
    });
    it("an alias bomb", () => {
        const lines = ["a: &a [x, x, x, x, x, x, x, x, x]"];
        for (const [prev, next] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"], ["f", "g"], ["g", "h"], ["h", "i"]] as const) lines.push(`${next}: &${next} [*${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}, *${prev}]`);
        expect(() => convert(`appId: com.a.b\nx:\n  ${lines.join("\n  ")}\n---\n- back\n`)).toThrow(MaestroSyntaxError);
    });
    it("duplicate keys", () => expect(() => convert("appId: com.a.b\nappId: com.c.d\n---\n- back\n")).toThrow(MaestroSyntaxError));
});

describe("the rendered Taqwright script is valid TypeScript against Taqwright's types", () => {
    it("type-checks, and uses the device calls the steps stand for", () => {
        const r = convert(LOGIN, "login.yaml");
        const script = renderScript(TestSpecSchema.parse({ ...r.spec, testId: "MOB-001" }), "taqwright", { baseUrl: "android-app://com.example.shop" }).content;
        for (const call of ["mobile.scroll(\"down\")", "mobile.swipe(\"left\")", "mobile.goBack()", "mobile.pressButton(\"HOME\")", ".scrollIntoView()", "mobile.press(\"Enter\")", "getByTestId(\"password_field\")"]) expect(script).toContain(call);

        // A real program over the real @taqwright/taqwright types, from a scratch folder inside the repo so the package resolves.
        const dir = fs.mkdtempSync(path.join(REPO_ROOT, ".validation", "maestro-check-"));
        try {
            const file = path.join(dir, "MOB-001.mobile.spec.ts");
            fs.writeFileSync(file, script);
            const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: ["node"] });
            const problems = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName.replace(/\\/g, "/") === file.replace(/\\/g, "/"));
            expect(problems.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }, 120_000);
});

// ── the route ───────────────────────────────────────────────────────────────

describe("POST /api/projects/:id/import/maestro", () => {
    let platform: Platform;
    let server: Awaited<ReturnType<typeof buildServer>>;
    let dataDir: string;
    let projectId: string;

    const call = async (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = {}) => {
        const res = await server.inject({ method, url, payload: payload as never, headers });
        return { status: res.statusCode, body: res.body && res.headers["content-type"]?.toString().includes("json") ? JSON.parse(res.body) : null, raw: res.body };
    };
    const importFlows = (files: Array<{ name: string; content: string }>, extra: Record<string, unknown> = {}) => call("POST", `/api/projects/${projectId}/import/maestro`, { files, validate: false, ...extra });

    beforeAll(async () => {
        for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-maestro-"));
        platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", WORKER_EMBEDDED: "false" }));
        server = await buildServer(platform);
        projectId = (await call("POST", "/api/projects", { name: "Maestro import" })).body.id;
    }, 30_000);
    afterAll(async () => {
        delete process.env.BLOCK_PRIVATE_TARGETS;
        await server?.close();
        platform?.db.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    it("a dry run reports what would happen and stores nothing", async () => {
        const r = await importFlows([{ name: "login.yaml", content: LOGIN }, { name: "empty.yaml", content: "appId: com.example.shop\n---\n- launchApp\n" }], { dryRun: true });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ dryRun: true, jobId: null, imported: [] });
        expect(r.body.reports.map((x: FlowReport) => [x.file, x.status])).toEqual([["login.yaml", "converted"], ["empty.yaml", "skipped"]]);
        expect(r.body.skipped).toEqual([{ file: "empty.yaml", reason: expect.stringMatching(/never verify/) }]);
        expect(r.body.reports[0].spec).toBeUndefined();
        expect((await call("GET", `/api/projects/${projectId}/tests`)).body).toHaveLength(0);
    });

    it("stores converted flows as mobile tests through the spec-import path, and says what it left out", async () => {
        const r = await importFlows([{ name: "login.yaml", content: LOGIN }, { name: "nothing.yaml", content: "appId: com.example.shop\n---\n- tapOn: Go\n" }]);
        expect(r.status).toBe(201);
        expect(r.body.jobId).toBeNull();
        expect(r.body.imported).toEqual([expect.objectContaining({ file: "login.yaml", kind: "mobile", testId: "MOB-001", steps: 14, checks: 2 })]);
        expect(r.body.skipped).toHaveLength(1);
        expect(r.body.reports[0].notes.length).toBeGreaterThan(0);

        const tests = (await call("GET", `/api/projects/${projectId}/tests`)).body as Array<{ id: string; testId: string; kind: string; framework: string }>;
        expect(tests).toHaveLength(1);
        expect(tests[0]).toMatchObject({ testId: "MOB-001", kind: "mobile", framework: "taqwright" });
        const script = (await call("GET", `/api/tests/${tests[0]!.id}/script`)).raw;
        expect(script).toContain("mobile.goBack()");
        expect(script).toContain("process.env.TEST_PASSWORD");
        expect(script).not.toContain(PW_SENTINEL);
        // the same spec can be exported again
        const exported = (await call("GET", `/api/projects/${projectId}/specs`)).body.specs[0];
        expect(exported).toMatchObject({ kind: "mobile", source: { origin: "imported" } });
        // nothing about the response or the stored data holds the value from the flow's env header
        expect(r.raw).not.toContain(PW_SENTINEL);
        expect(JSON.stringify(exported)).not.toContain(PW_SENTINEL);
        // the app to test was set from the flow's appId
        const app = platform.repo.getLatestApplicationPublic(projectId) as { config?: { mobile?: { appPackage?: string } } } | undefined;
        expect(app?.config?.mobile?.appPackage).toBe("com.example.shop");
    });

    it("queues a validation run when asked to run the tests", async () => {
        const r = await importFlows([{ name: "again.yaml", content: flow("- tapOn: Again") }], { validate: true });
        expect(r.status).toBe(202);
        expect(typeof r.body.jobId).toBe("string");
        expect(r.body.imported[0].testId).toBe("MOB-002");
    });

    it("imports a web flow against the origin of its url", async () => {
        const p2 = (await call("POST", "/api/projects", { name: "Web flows" })).body.id;
        const r = await call("POST", `/api/projects/${p2}/import/maestro`, { validate: false, files: [{ name: "search.yaml", content: "url: http://127.0.0.1:5671/start\n---\n- tapOn: Search\n- assertVisible: Results\n" }] });
        expect(r.status).toBe(201);
        expect(r.body.imported[0]).toMatchObject({ kind: "web", testId: "WEB-001" });
        const t = (await call("GET", `/api/projects/${p2}/tests`)).body[0];
        expect(t).toMatchObject({ kind: "web", framework: "playwright" });
        expect((platform.repo.getLatestApplicationPublic(p2) as { url: string }).url).toBe("http://127.0.0.1:5671");
    });

    it("refuses a private web address when the platform blocks them (the same guard as spec import)", async () => {
        const p3 = (await call("POST", "/api/projects", { name: "Guarded" })).body.id;
        process.env.BLOCK_PRIVATE_TARGETS = "true";
        try {
            const r = await call("POST", `/api/projects/${p3}/import/maestro`, { validate: false, files: [{ name: "x.yaml", content: "url: http://127.0.0.1:5672/\n---\n- assertVisible: Hi\n" }] });
            expect(r.status).toBe(400);
            expect((await call("GET", `/api/projects/${p3}/tests`)).body).toHaveLength(0);
        } finally {
            delete process.env.BLOCK_PRIVATE_TARGETS;
        }
    });

    it("answers 400 for unreadable YAML and lists every bad file", async () => {
        const r = await importFlows([{ name: "ok.yaml", content: flow("- back") }, { name: "bad.yaml", content: "appId: [oops\n---\n- back" }, { name: "worse.yaml", content: "- tapOn: {a: 1\n" }]);
        expect(r.status).toBe(400);
        expect(r.body.error).toMatch(/not valid YAML/);
        expect(r.body.details.map((d: { file: string }) => d.file)).toEqual(["bad.yaml", "worse.yaml"]);
    });

    it("enforces the caps and validates the request", async () => {
        const many = await importFlows(Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.yaml`, content: flow("- back") })));
        expect(many.status).toBe(400);
        expect(many.body.error).toMatch(/at most 100/);
        const big = await importFlows([{ name: "huge.yaml", content: `${flow("- back")}# ${"x".repeat(201 * 1024)}` }]);
        expect(big.status).toBe(400);
        expect(big.body.error).toMatch(/huge\.yaml is larger than 200 KB/);
        expect((await importFlows([])).status).toBe(400);
        expect((await call("POST", `/api/projects/${projectId}/import/maestro`, { files: "nope" })).status).toBe(400);
        expect((await call("POST", `/api/projects/nope/import/maestro`, { files: [{ name: "a.yaml", content: "x" }] })).status).toBe(404);
    });

    it("tells a batch that nothing could be imported, without error", async () => {
        const r = await importFlows([{ name: "config.yaml", content: "flows: ['*']" }, { name: "plain.yaml", content: "just: a map\n" }]);
        expect(r.status).toBe(200);
        expect(r.body.imported).toEqual([]);
        expect(r.body.skipped.map((s: { file: string }) => s.file)).toEqual(["config.yaml", "plain.yaml"]);
    });
});

describe("the import route with an API key", () => {
    it("passes the caller's key on to the spec import", async () => {
        const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-maestro-key-"));
        const platform = bootstrap(loadConfig({ DATA_DIR: dataDir, SECRET_KEY: "test-secret-key-0123456789", WORKER_EMBEDDED: "false", API_KEY: "maestro-test-key" }));
        const server = await buildServer(platform);
        try {
            const h = { "x-api-key": "maestro-test-key" };
            const id = JSON.parse((await server.inject({ method: "POST", url: "/api/projects", payload: { name: "Keyed" }, headers: h })).body).id;
            const body = { validate: false, files: [{ name: "a.yaml", content: flow("- back") }] };
            expect((await server.inject({ method: "POST", url: `/api/projects/${id}/import/maestro`, payload: body })).statusCode).toBe(401);
            expect((await server.inject({ method: "POST", url: `/api/projects/${id}/import/maestro`, payload: body, headers: h })).statusCode).toBe(201);
        } finally {
            await server.close();
            platform.db.close();
            fs.rmSync(dataDir, { recursive: true, force: true });
        }
    }, 30_000);
});
