/**
 * The AI phone explorer's device session, the parts that need no phone, no adb and no server: the screen description parser, fingerprints, "outside the
 * app", every action's checks, the credential rules, the covering and encoding of the picture, the closed list of adb commands, the protocol messages,
 * where a phone session runs (decision table) and the remote driver's state machine with an injected clock. Fast tier.
 */
import { describe, expect, it } from "vitest";
import { CheckedTaskOffer, Capabilities, DeviceActionWire, DeviceCommand, DevicePush, DeviceSnapshotWire, HeartbeatResponse, TaskOffer, DEVICE_MAX_IMAGE_B64 } from "../src/agent-protocol/schema.js";
import { answerDeviceCommand } from "../src/agent/device-task.js";
import { allowedCommand, shellQuoteForInput } from "../src/engine/mobile/device/adb.js";
import { PLACEHOLDER_PASSWORD, PLACEHOLDER_USERNAME, REFUSALS, parseAction, planAction, scrollPlan, untypable } from "../src/engine/mobile/device/actions.js";
import { deviceSessionProblem } from "../src/engine/mobile/device/capability.js";
import { DeviceSessionError } from "../src/engine/mobile/device/errors.js";
import { AC_COUNTS, AC_VALUES, COVER_RGB, DC_COUNTS, DC_VALUES, coverRects, decodePng, encodeJpeg, encodePng, scaleDown, screenshotJpeg, type Raster } from "../src/engine/mobile/device/image.js";
import type { DeviceAction, ScreenElement, ScreenSnapshot } from "../src/engine/mobile/device/types.js";
import { SCREEN_TOO_LARGE, SCREEN_UNREADABLE, activityFromWindowDump, cleanText, fingerprintOf, isLockedFromWindowDump, keyboardFromInputDump, parseHierarchy } from "../src/engine/mobile/device/uiautomator.js";
import { agentRouteOf, isAgentRoute } from "../src/platform/agent-routing.js";
import { RemoteDeviceDriver, chooseDeviceHost, cleanDeviceSnapshot, deviceAdapterId, deviceProblem, isDeviceAdapter, type RemoteDeviceDeps } from "../src/platform/agent-device.js";
import type { AgentRecord } from "../src/platform/agent-store.js";

// ── a real-looking `uiautomator dump` ──────────────────────────────────────

const PKG = "com.example.shop";
type Attrs = Partial<Record<string, string | boolean>>;
const node = (a: Attrs, kids = ""): string => {
    const d: Record<string, string | boolean> = {
        index: "0", text: "", "resource-id": "", class: "android.widget.TextView", package: PKG, "content-desc": "", checkable: false, checked: false, clickable: false, enabled: true,
        focusable: false, focused: false, scrollable: false, "long-clickable": false, password: false, selected: false, bounds: "[0,0][1080,2400]", ...a,
    };
    const attrs = Object.entries(d).map(([k, v]) => `${k}="${v}"`).join(" ");
    return kids ? `<node ${attrs}>${kids}</node>` : `<node ${attrs} />`;
};
const dump = (inner: string, rootPkg = PKG): string => `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${node({ class: "android.widget.FrameLayout", package: rootPkg }, inner)}</hierarchy>\nUI hierchary dumped to: /dev/tty\n`;
const parse = (xml: string, extra: { activity?: string; keyboard?: boolean; appPackage?: string } = {}) => parseHierarchy(xml, { appPackage: PKG, ...extra });
const ok = (xml: string, extra?: Parameters<typeof parse>[1]) => {
    const r = parse(xml, extra);
    if (!r.ok) throw new Error(`parse failed: ${r.error}`);
    return r.snapshot;
};

const LOGIN = dump(
    node({ class: "android.widget.LinearLayout", bounds: "[0,63][1080,2400]" },
        node({ text: "Sign in", "resource-id": "com.example.shop:id/title", bounds: "[48,120][1032,200]" }) +
            node({ class: "android.widget.EditText", "resource-id": "com.example.shop:id/username", "content-desc": "Username", clickable: true, focusable: true, bounds: "[48,300][1032,420]" }) +
            node({ class: "android.widget.EditText", "resource-id": "com.example.shop:id/password", text: "••••••••", password: true, clickable: true, focusable: true, bounds: "[48,440][1032,560]" }) +
            node({ class: "android.widget.Button", "resource-id": "com.example.shop:id/login_button", text: "Log in", clickable: true, bounds: "[48,600][1032,720]" }),
    ),
);

describe("the screen description parser", () => {
    it("keeps what a person could see or touch, drops empty layouts, and names the fields", () => {
        const s = ok(LOGIN, { activity: "com.example.shop.LoginActivity" });
        expect(s.package).toBe(PKG);
        expect(s.activity).toBe("com.example.shop.LoginActivity");
        expect([s.width, s.height]).toEqual([1080, 2400]);
        expect(s.elements.map((e) => [e.index, e.cls, e.id, e.text, e.desc])).toEqual([
            [0, "TextView", "title", "Sign in", ""],
            [1, "EditText", "username", "", "Username"],
            [2, "EditText", "password", "", ""],
            [3, "Button", "login_button", "Log in", ""],
        ]);
        expect(s.elements[1]).toMatchObject({ editable: true, password: false, clickable: true, enabled: true, bounds: [48, 300, 1032, 420] });
        expect(s.elements[2]).toMatchObject({ editable: true, password: true });
        expect(s.outsideApp).toBe(false);
        expect(s.keyboard).toBe(false);
    });

    it("never reads a password field: its text is empty even when the app put the real password in the description", () => {
        const secret = "hunter2-SECRET-value";
        const xml = dump(node({ class: "android.widget.EditText", text: secret, password: true, clickable: true, bounds: "[0,100][500,200]" }) + node({ text: "plain", bounds: "[0,300][500,360]" }));
        const s = ok(xml);
        expect(JSON.stringify(s)).not.toContain(secret);
        expect(s.elements[0]).toMatchObject({ password: true, text: "" });
    });

    it("decodes entities, removes control, direction and zero-width characters, and cuts text to 80 characters without splitting a pair", () => {
        const ZW = String.fromCharCode(0x200b);
        const RLO = String.fromCharCode(0x202e);
        const xml = dump(
            node({ text: `A &amp; B &lt;ok&gt; &quot;q&quot; &#10;next &#x1F600; bell&#7;esc&#27;[31m${RLO}rev${ZW}ersed`, bounds: "[0,100][500,160]" }) +
                node({ text: `${"a".repeat(79)}\u{1F600}tail`, bounds: "[0,200][500,260]" }),
        );
        const [a, b] = ok(xml).elements;
        expect(a!.text).toBe('A & B <ok> "q" next \u{1F600} bell esc [31m rev ersed');
        expect(a!.text).not.toMatch(/[\u0000-\u001f\u202e\u200b]/);
        expect(b!.text).toBe("a".repeat(79));
        expect(b!.text.length).toBeLessThanOrEqual(80);
    });

    it("lists the elements in reading order, whatever order the document has them in", () => {
        const xml = dump(node({ text: "third", bounds: "[500,300][900,360]" }) + node({ text: "second", bounds: "[10,300][400,360]" }) + node({ text: "first", bounds: "[0,50][900,100]" }));
        expect(ok(xml).elements.map((e) => e.text)).toEqual(["first", "second", "third"]);
    });

    it("lists at most 120 elements, keeping what can be touched before what can only be read", () => {
        let inner = "";
        for (let i = 0; i < 150; i++) inner += node({ text: `label ${i}`, bounds: `[0,${i * 10}][100,${i * 10 + 8}]` });
        for (let i = 0; i < 100; i++) inner += node({ class: "android.widget.Button", text: `button ${i}`, clickable: true, bounds: `[200,${i * 10}][300,${i * 10 + 8}]` });
        const s = ok(dump(inner));
        expect(s.elements).toHaveLength(120);
        expect(s.elements.map((e) => e.index)).toEqual([...Array(120).keys()]);
        expect(s.elements.filter((e) => e.clickable)).toHaveLength(100);
    });

    it("drops the status bar of the system and the elements with no area", () => {
        const xml = dump(node({ text: "11:42", package: "com.android.systemui", bounds: "[0,0][200,60]" }) + node({ text: "real", bounds: "[0,100][100,150]" }) + node({ text: "flat", bounds: "[0,200][0,260]" }));
        expect(ok(xml).elements.map((e) => e.text)).toEqual(["real"]);
    });

    it("never throws: malformed, truncated and hostile documents come back as an explicit error", () => {
        const bad = [
            "", "not xml", "<hierarchy>", "<hierarchy><node", "<hierarchy><node text=\"x></hierarchy>", "<hierarchy></node></hierarchy>",
            "<?xml version='1.0'?><!DOCTYPE hierarchy [<!ENTITY x \"y\">]><hierarchy/>", "<hierarchy><![CDATA[x]]></hierarchy>",
            LOGIN.slice(0, LOGIN.length - 60), LOGIN.replace("</hierarchy>", ""), `<hierarchy><node bounds="[0,0][1,1]"><node></hierarchy>`,
        ];
        for (const xml of bad) {
            const r = parse(xml);
            expect(r.ok, xml.slice(0, 40)).toBe(false);
            if (!r.ok) expect(r.error).toBe(SCREEN_UNREADABLE);
        }
        // every cut of a valid document either parses or fails cleanly
        for (let n = 0; n < LOGIN.length; n += 37) expect(() => parse(LOGIN.slice(0, n))).not.toThrow();
        // a node whose bounds are rubbish is skipped, the rest is read
        expect(ok(dump(node({ text: "kept", bounds: "[0,0][10,10]" }) + node({ text: "bad", bounds: "oops" }))).elements.map((e) => e.text)).toEqual(["kept"]);
    });

    it("refuses a document over 2 MB without reading it", () => {
        const huge = dump(node({ text: "x".repeat(2 * 1024 * 1024 + 10) }));
        const r = parse(huge);
        expect(r).toEqual({ ok: false, error: SCREEN_TOO_LARGE });
    });

    it("survives a tree far deeper than any screen (depth guard) and many thousands of nodes (node cap)", () => {
        let deep = node({ text: "bottom", bounds: "[0,0][10,10]" });
        for (let i = 0; i < 400; i++) deep = node({ class: "android.widget.FrameLayout", bounds: "[0,0][100,100]" }, deep);
        expect(() => parse(dump(deep))).not.toThrow();
        const r = parse(dump(deep));
        expect(r.ok && r.snapshot.elements.every((e) => e.text !== "bottom")).toBe(true);
        let many = "";
        for (let i = 0; i < 9000; i++) many += node({ text: "n", bounds: "[0,0][10,10]" });
        expect(parse(dump(many))).toEqual({ ok: false, error: SCREEN_TOO_LARGE });
    });

    it("picks the largest window as the screen", () => {
        const xml = `<?xml version='1.0'?><hierarchy rotation="0">${node({ class: "android.widget.FrameLayout", package: "com.android.systemui", bounds: "[0,0][1080,80]" }, node({ text: "clock", package: "com.android.systemui", bounds: "[0,0][100,80]" }))}${node({ class: "android.widget.FrameLayout", bounds: "[0,0][1080,2400]" }, node({ text: "app text", bounds: "[0,100][500,160]" }))}</hierarchy>`;
        const s = ok(xml);
        expect(s.package).toBe(PKG);
        expect(s.elements.map((e) => e.text)).toEqual(["app text"]);
    });
});

describe("fingerprints and 'outside the app'", () => {
    const base = (editText = "") => dump(node({ text: "Welcome", "resource-id": "title", bounds: "[0,0][500,80]" }) + node({ class: "android.widget.EditText", text: editText, "resource-id": "q", clickable: true, bounds: "[0,100][500,160]" }) + node({ class: "android.widget.Button", text: "Go", clickable: true, bounds: "[0,200][500,260]" }));

    it("is equal for the same screen, ignores what is typed into a field, and changes with the screen", () => {
        const a = ok(base()).fingerprint;
        expect(ok(base()).fingerprint).toBe(a);
        expect(ok(base("something typed")).fingerprint).toBe(a);
        expect(ok(base().replace("Welcome", "Goodbye")).fingerprint).not.toBe(a);
        expect(parse(base(), { activity: "A" }).ok && ok(base(), { activity: "A" }).fingerprint).not.toBe(ok(base(), { activity: "B" }).fingerprint);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
        // element order in the document does not matter
        const el = (text: string): ScreenElement => ({ index: 0, cls: "TextView", text, desc: "", id: "", clickable: false, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [0, 0, 1, 1] });
        expect(fingerprintOf("p", undefined, [el("a"), el("b")])).toBe(fingerprintOf("p", undefined, [el("b"), el("a")]));
    });

    it.each([
        [PKG, false],
        ["com.android.permissioncontroller", true],
        ["com.google.android.permissioncontroller", true],
        ["com.android.systemui", true],
        ["android", true],
        ["com.android.chrome", true],
        ["com.android.launcher3", true],
    ])("package %s in front: outsideApp is %s", (pkg, outside) => {
        expect(ok(dump(node({ text: "x", package: pkg, bounds: "[0,0][10,10]" }), pkg)).outsideApp).toBe(outside);
    });

    it("reads the activity, the lock screen and the keyboard from the dumps the system prints", () => {
        expect(activityFromWindowDump("  mCurrentFocus=Window{4f2a1c u0 com.example.shop/com.example.shop.MainActivity}\n")).toEqual({ package: "com.example.shop", activity: "com.example.shop.MainActivity" });
        expect(activityFromWindowDump("  mFocusedApp=ActivityRecord{abc u0 com.example.shop/.MainActivity t12}\n")).toEqual({ package: "com.example.shop", activity: "com.example.shop.MainActivity" });
        expect(activityFromWindowDump("nothing here")).toBeUndefined();
        expect(isLockedFromWindowDump("isKeyguardShowing=true")).toBe(true);
        expect(isLockedFromWindowDump("isKeyguardShowing=false")).toBe(false);
        // Some emulator images leave the keyguard flag set on the home screen: a launcher or an app in focus means it is usable, not locked.
        expect(isLockedFromWindowDump("mCurrentFocus=Window{304b33f u0 com.google.android.apps.nexuslauncher/com.google.android.apps.nexuslauncher.NexusLauncherActivity}\n  isKeyguardShowing=true\n  mDreamingLockscreen=true")).toBe(false);
        expect(isLockedFromWindowDump("mCurrentFocus=null\n  mFocusedApp=ActivityRecord{6d405f5 u0 com.android.settings/.Settings t7}\n  isKeyguardShowing=true")).toBe(false);
        // The lock screen or shade actually in front, or nothing focused: locked.
        expect(isLockedFromWindowDump("mCurrentFocus=Window{a u0 StatusBar}\n  isKeyguardShowing=true")).toBe(true);
        expect(isLockedFromWindowDump("mCurrentFocus=Window{b u0 com.android.systemui/com.android.systemui.keyguard.KeyguardService}\n  isKeyguardShowing=true")).toBe(true);
        expect(isLockedFromWindowDump("mCurrentFocus=null\n  mFocusedApp=null\n  isKeyguardShowing=true")).toBe(true);
        expect(keyboardFromInputDump("mInputShown=true")).toBe(true);
        expect(keyboardFromInputDump("mInputShown=false")).toBe(false);
    });

    it("cleanText strips and cuts", () => {
        expect(cleanText("  a\n\tb\u0007c  ")).toBe("a b c");
        expect(cleanText("x".repeat(200))).toHaveLength(80);
        expect(cleanText("lone" + String.fromCharCode(0xd83d))).toBe("lone");
    });
});

// ── actions ─────────────────────────────────────────────────────────────────

const el = (i: number, o: Partial<ScreenElement> = {}): ScreenElement => ({
    index: i, cls: "Button", text: `item ${i}`, desc: "", id: "", clickable: true, longClickable: false, scrollable: false, editable: false, password: false, checkable: false, checked: false, enabled: true, focused: false, bounds: [100, 100 + i * 200, 900, 200 + i * 200], ...o,
});
const snap = (elements: ScreenElement[]): ScreenSnapshot => ({ package: PKG, width: 1080, height: 2400, elements, fingerprint: "f", keyboard: false, outsideApp: false });
const screen = snap([el(0), el(1, { cls: "EditText", text: "", editable: true }), el(2, { cls: "EditText", editable: true, password: true, text: "" }), el(3, { enabled: false }), el(4, { scrollable: true, clickable: false, bounds: [0, 1000, 1080, 2000] }), el(5, { bounds: [0, 2300, 500, 2900] }), el(6, { bounds: [2000, 100, 2400, 200] })]);
const run = (a: unknown, creds?: { username?: string; password?: string }, last: ScreenSnapshot | null = screen) => {
    const p = parseAction(a);
    return p.ok ? planAction(p.action, last ?? undefined, creds) : p;
};
const err = (r: { ok: boolean; error?: string }) => (r.ok ? undefined : r.error);

describe("every action's checks", () => {
    it("a tap goes to the centre of the element's bounds, computed here (the model never gives a coordinate)", () => {
        expect(run({ kind: "tap", index: 0 })).toMatchObject({ ok: true, plan: { kind: "tap", x: 500, y: 150 } });
        expect(run({ kind: "longPress", index: 0 })).toMatchObject({ ok: true, plan: { kind: "longPress", x: 500, y: 150 } });
        // an element half off the screen is tapped in the part that shows
        expect(run({ kind: "tap", index: 5 })).toMatchObject({ ok: true, plan: { x: 250, y: 2350 } });
    });

    it.each([
        [{ kind: "tap", index: 99 }, REFUSALS.stale],
        [{ kind: "tap", index: 7 }, REFUSALS.stale],
        [{ kind: "tap", index: 3 }, REFUSALS.disabled],
        [{ kind: "tap", index: 6 }, REFUSALS.notVisible],
        [{ kind: "type", index: 0, text: "x" }, REFUSALS.notTextField],
        [{ kind: "scroll", index: 0, direction: "down" }, REFUSALS.notScrollable],
    ])("%j is refused in plain words", (action, message) => {
        expect(err(run(action))).toBe(message);
    });

    it("an element number needs a snapshot to refer to", () => {
        expect(err(run({ kind: "tap", index: 0 }, undefined, null))).toBe(REFUSALS.nothingYet);
        expect(run({ kind: "back" }, undefined, null).ok).toBe(true);
        expect(run({ kind: "launch" }, undefined, null).ok).toBe(true);
    });

    it.each([
        [{ kind: "tap", index: -1 }, "not on the screen"],
        [{ kind: "tap", index: 1.5 }, "whole number"],
        [{ kind: "tap", index: "1" }, "whole number"],
        [{ kind: "tap" }, ""],
        [{ kind: "scroll", direction: "sideways" }, "Scroll up, down, left or right"],
        [{ kind: "wait", ms: 3001 }, "limited to 3 seconds"],
        [{ kind: "wait", ms: -5 }, "positive"],
        [{ kind: "wait", ms: 10.5 }, "whole number"],
        [{ kind: "shell", command: "rm -rf /" }, "not something the phone"],
        [{ kind: "tap", index: 1, x: 5, y: 9 }, "can't carry coordinates, packages or commands"],
        [{ kind: "launch", package: "com.evil.app" }, "can't carry coordinates, packages or commands"],
        [{ kind: "type", index: 1, text: "x".repeat(201) }, "at most 200"],
        [null, "not something the phone"],
        ["tap", "not something the phone"],
    ])("a badly shaped action %j is refused (%s)", (action, part) => {
        const r = parseAction(action);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain(part);
    });

    it("accepts every action the contract has, with its optional parts", () => {
        const all: DeviceAction[] = [
            { kind: "tap", index: 0 }, { kind: "longPress", index: 1 }, { kind: "type", index: 2, text: "hi", clear: true }, { kind: "scroll", direction: "up" },
            { kind: "scroll", index: 4, direction: "left" }, { kind: "back" }, { kind: "hideKeyboard" }, { kind: "launch" }, { kind: "restart" }, { kind: "wait", ms: 3000 }, { kind: "wait", ms: 0 },
        ];
        for (const a of all) expect(parseAction(a)).toEqual({ ok: true, action: a });
        // both directions assign: a field added to one side and not the other fails to compile here
        const wire: DeviceActionWire = all[0] as DeviceAction;
        const back: DeviceAction = wire;
        expect(back.kind).toBe("tap");
    });

    it("scrolling swipes inside the element in the middle half of it; 'down' moves the finger up", () => {
        const down = run({ kind: "scroll", index: 4, direction: "down" });
        expect(down).toMatchObject({ ok: true, plan: { kind: "scroll", from: [540, 1750], to: [540, 1250] } });
        const up = scrollPlan([0, 0, 1000, 2000], "up");
        expect(up.from[1]).toBeLessThan(up.to[1]);
        const right = scrollPlan([0, 0, 1000, 2000], "right");
        expect(right.from[0]).toBeGreaterThan(right.to[0]);
        // without an element the whole screen is used
        expect(run({ kind: "scroll", direction: "down" })).toMatchObject({ ok: true, plan: { kind: "scroll", from: [540, 1800], to: [540, 600] } });
    });
});

describe("what may be typed", () => {
    it("types printable ASCII, including text that looks like a shell command (it travels as one quoted word)", () => {
        for (const text of ["hello world", "; rm -rf /", "$(reboot)", "`id`", "a'b\"c", "x && y | z > /sdcard/f", "100%", "back\\slash"]) {
            const r = run({ kind: "type", index: 1, text });
            expect(r, text).toMatchObject({ ok: true, plan: { kind: "type", text, secret: false } });
            expect(allowedCommand(["shell", "input", "text", shellQuoteForInput(text)]), text).toBe(true);
        }
    });

    it("refuses what the phone can not take safely, with the reason", () => {
        expect(err(run({ kind: "type", index: 1, text: "line one\nline two" }))).toBe(REFUSALS.lineBreak);
        expect(err(run({ kind: "type", index: 1, text: "a\tb" }))).toBe(REFUSALS.lineBreak);
        expect(err(run({ kind: "type", index: 1, text: "Café" }))).toBe(REFUSALS.notAscii);
        expect(err(run({ kind: "type", index: 1, text: "日本語" }))).toBe(REFUSALS.notAscii);
        expect(err(run({ kind: "type", index: 1, text: "emoji \u{1F600}" }))).toBe(REFUSALS.notAscii);
        expect(err(run({ kind: "type", index: 1, text: "50%sale" }))).toBe(REFUSALS.percentS);
        expect(err(run({ kind: "type", index: 1, text: "" }))).toBe(REFUSALS.nothingToType);
        expect(run({ kind: "type", index: 1, text: "", clear: true })).toMatchObject({ ok: true, plan: { kind: "type", text: "", clearCount: expect.any(Number) } });
        expect(untypable("plain text")).toBeUndefined();
    });

    it("quotes text as one word: a space is %s, a quote is closed and reopened, nothing else is touched", () => {
        expect(shellQuoteForInput("a b")).toBe("'a%sb'");
        expect(shellQuoteForInput("it's")).toBe("'it'\\''s'");
        expect(shellQuoteForInput("; rm -rf /")).toBe("';%srm%s-rf%s/'");
        expect(shellQuoteForInput("$(id) `id` \"x\"")).toBe("'$(id)%s`id`%s\"x\"'");
    });

    it("a password field accepts only the stand-in, and the real value comes from the credentials on this computer", () => {
        const creds = { username: "tester@example.test", password: "Sup3r-Secret-pw!" };
        const good = run({ kind: "type", index: 2, text: PLACEHOLDER_PASSWORD }, creds);
        expect(good).toMatchObject({ ok: true, plan: { kind: "type", text: creds.password, secret: true } });
        // a plan holds the real value, so a refusal or an answer must never be built from one: every refusal below is checked for the value
        const refusals = [
            run({ kind: "type", index: 2, text: "my-own-password" }, creds),
            run({ kind: "type", index: 2, text: PLACEHOLDER_USERNAME }, creds),
            run({ kind: "type", index: 2, text: `${PLACEHOLDER_PASSWORD} ` }, creds),
            run({ kind: "type", index: 2, text: PLACEHOLDER_PASSWORD }),
            run({ kind: "type", index: 2, text: PLACEHOLDER_PASSWORD }, { username: "u" }),
            run({ kind: "type", index: 1, text: PLACEHOLDER_PASSWORD }, creds),
            run({ kind: "type", index: 1, text: "{{credentials.token}}" }, creds),
            run({ kind: "type", index: 1, text: `{{credentials.password}} and more` }, creds),
        ];
        for (const r of refusals) {
            expect(r.ok).toBe(false);
            expect(JSON.stringify(r)).not.toContain(creds.password);
        }
        expect(err(refusals[0]!)).toBe(REFUSALS.passwordOnly);
        expect(err(refusals[3]!)).toBe(REFUSALS.needCredentials);
        expect(REFUSALS.needCredentials).toContain("Sign-in details are needed for this field");
        expect(err(refusals[5]!)).toBe(REFUSALS.passwordElsewhere);
        expect(err(refusals[6]!)).toBe(REFUSALS.unknownPlaceholder);
    });

    it("the user name stand-in goes into any text field; a stored value the phone can't type is refused without being shown", () => {
        const creds = { username: "tester@example.test", password: "pw-ok-12345" };
        expect(run({ kind: "type", index: 1, text: PLACEHOLDER_USERNAME }, creds)).toMatchObject({ ok: true, plan: { text: "tester@example.test", secret: false } });
        expect(err(run({ kind: "type", index: 1, text: PLACEHOLDER_USERNAME }))).toBe(REFUSALS.needCredentials);
        const odd = run({ kind: "type", index: 2, text: PLACEHOLDER_PASSWORD }, { password: "pässword-secret-1" });
        expect(err(odd)).toBe(REFUSALS.storedUntypable);
        expect(JSON.stringify(odd)).not.toContain("pässword");
    });
});

// ── the closed list of adb commands ─────────────────────────────────────────

describe("the closed list of adb commands", () => {
    const ok = [
        ["devices", "-l"], ["devices"], ["install", "-r", "C:\\apps\\shop debug.apk"], ["exec-out", "screencap", "-p"], ["exec-out", "uiautomator", "dump", "/dev/tty"],
        ["shell", "getprop", "ro.product.model"], ["shell", "getprop", "sys.boot_completed"], ["shell", "dumpsys", "window"], ["shell", "dumpsys", "input_method"],
        ["shell", "pm", "list", "packages"], ["shell", "am", "force-stop", "com.example.shop"], ["shell", "monkey", "-p", "com.example.shop", "-c", "android.intent.category.LAUNCHER", "1"],
        ["shell", "input", "tap", "540", "1200"], ["shell", "input", "swipe", "540", "1750", "540", "1250", "350"], ["shell", "input", "keyevent", "KEYCODE_BACK"],
        ["shell", "input", "keyevent", "KEYCODE_MOVE_END", "KEYCODE_DEL", "KEYCODE_DEL"], ["shell", "input", "text", "'a%sb'"],
    ];
    const bad = [
        [], ["shell"], ["shell", "rm", "-rf", "/sdcard"], ["shell", "sh", "-c", "id"], ["shell", "settings", "put", "global", "adb_enabled", "0"], ["shell", "pm", "grant", "com.x.y", "android.permission.CAMERA"],
        ["shell", "pm", "uninstall", "com.example.shop"], ["uninstall", "com.example.shop"], ["install", "evil.sh"], ["install", "-r", "-g", "a.apk"], ["shell", "am", "start", "-n", "com.x/.Y"],
        ["shell", "am", "force-stop", "com.example.shop; reboot"], ["shell", "am", "force-stop", "-a"], ["shell", "monkey", "-p", "com.example.shop", "1000"], ["shell", "monkey", "-p", "bad pkg", "-c", "android.intent.category.LAUNCHER", "1"],
        ["shell", "input", "tap", "1;reboot", "5"], ["shell", "input", "tap", "1", "2", "3"], ["shell", "input", "keyevent", "rm"], ["shell", "input", "text", "a;reboot"], ["shell", "input", "text", "'a'; reboot"],
        ["shell", "input", "text", "unquoted"], ["shell", "input", "roll", "1", "2"], ["shell", "getprop"], ["shell", "getprop", "ro.secret"], ["shell", "dumpsys", "package"], ["shell", "dumpsys", "window", "x"],
        ["exec-out", "cat", "/data/secret"], ["exec-out", "uiautomator", "dump", "/sdcard/x.xml"], ["reboot"], ["root"], ["pull", "/sdcard/x"], ["push", "a", "/sdcard/a"], ["forward", "tcp:1", "tcp:2"], ["emu", "kill"], ["shell", "input", "text", "'" + "x".repeat(1300) + "'"],
    ];
    it.each(ok)("allows %j", (...a) => expect(allowedCommand(a)).toBe(true));
    it.each(bad)("refuses %j", (...a) => expect(allowedCommand(a)).toBe(false));
});

// ── the picture ─────────────────────────────────────────────────────────────

const gradient = (w: number, h: number): Raster => {
    const rgb = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgb.set([(x * 255) / Math.max(1, w - 1), (y * 255) / Math.max(1, h - 1), (x + y) % 256], (y * w + x) * 3);
    return { width: w, height: h, rgb };
};
const px = (r: Raster, x: number, y: number) => [...r.rgb.slice((y * r.width + x) * 3, (y * r.width + x) * 3 + 3)];

describe("the picture: a password field is covered before anything leaves", () => {
    it("PNG round trip is exact", () => {
        const img = gradient(17, 13);
        const back = decodePng(encodePng(img))!;
        expect([back.width, back.height]).toEqual([17, 13]);
        expect(Buffer.from(back.rgb).equals(Buffer.from(img.rgb))).toBe(true);
        expect(decodePng(Buffer.from("not a png"))).toBeUndefined();
        expect(decodePng(encodePng(img).subarray(0, 40))).toBeUndefined();
    });

    it("coverRects paints the rectangle (and a small margin) a flat colour and leaves the rest alone", () => {
        const img = gradient(100, 100);
        const before = Uint8Array.from(img.rgb);
        coverRects(img, [[40, 40, 60, 50]], 2);
        expect(px(img, 50, 45)).toEqual([...COVER_RGB]);
        expect(px(img, 38, 38)).toEqual([...COVER_RGB]);
        expect(px(img, 61, 51)).toEqual([...COVER_RGB]);
        expect(px(img, 37, 45)).toEqual(px({ ...img, rgb: before }, 37, 45));
        expect(px(img, 10, 10)).toEqual(px({ ...img, rgb: before }, 10, 10));
        // a rectangle partly outside the picture does not throw
        expect(() => coverRects(img, [[-50, -50, 5, 5], [90, 90, 500, 500]])).not.toThrow();
    });

    it("scaleDown never scales up and averages what it merges", () => {
        const wide = gradient(1080, 600);
        expect(scaleDown(wide, 640)).toMatchObject({ width: 640, height: 356 });
        expect(scaleDown(gradient(300, 100), 640).width).toBe(300);
        const two: Raster = { width: 2, height: 1, rgb: Uint8Array.from([0, 0, 0, 255, 255, 255]) };
        expect(px(scaleDown(two, 1), 0, 0)).toEqual([128, 128, 128]);
    });

    it("the Huffman tables are complete and the JPEG has the right frame", () => {
        expect(DC_COUNTS.reduce((a, b) => a + b, 0)).toBe(DC_VALUES.length);
        expect(AC_COUNTS.reduce((a, b) => a + b, 0)).toBe(AC_VALUES.length);
        expect(AC_VALUES).toHaveLength(162);
        expect(new Set(AC_VALUES).size).toBe(162);
        const jpeg = encodeJpeg(gradient(37, 21), 60);
        expect([...jpeg.subarray(0, 2)]).toEqual([0xff, 0xd8]);
        expect([...jpeg.subarray(jpeg.length - 2)]).toEqual([0xff, 0xd9]);
        const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
        expect(jpeg.readUInt16BE(sof + 5)).toBe(21);
        expect(jpeg.readUInt16BE(sof + 7)).toBe(37);
    });

    it("screenshotJpeg covers on the full-size pixels, scales to at most 640 wide and stays under 120 KB even for noise", () => {
        const big = gradient(1080, 2400);
        const png = encodePng(big);
        const shot = screenshotJpeg(png, [[48, 440, 1032, 560]], { coverSpace: { width: 1080, height: 2400 } })!;
        expect(shot.width).toBeLessThanOrEqual(640);
        expect(shot.jpeg.length).toBeLessThanOrEqual(120_000);
        expect(screenshotJpeg(Buffer.from("junk"), [])).toBeUndefined();
        // noise is the worst case for a JPEG: the quality and then the width step down until it fits
        const noise = gradient(720, 1280);
        for (let i = 0; i < noise.rgb.length; i++) noise.rgb[i] = (i * 2654435761) >>> 24;
        const n = screenshotJpeg(encodePng(noise), [])!;
        expect(n.jpeg.length).toBeLessThanOrEqual(120_000);
    });
});

// ── the protocol ────────────────────────────────────────────────────────────

const snapshotWire = (): DeviceSnapshotWire => ({ package: PKG, activity: "A", width: 1080, height: 2400, elements: ok2().elements, fingerprint: "abc", keyboard: false, outsideApp: false });
function ok2(): ScreenSnapshot {
    return ok(LOGIN) as ScreenSnapshot;
}

describe("protocol: the phone session messages", () => {
    it("a snapshot the parser produced fits the wire, and the wire's caps hold", () => {
        const w = snapshotWire();
        expect(DeviceSnapshotWire.safeParse(w).success).toBe(true);
        expect(DeviceSnapshotWire.safeParse({ ...w, elements: Array.from({ length: 121 }, (_, i) => ({ ...w.elements[0]!, index: i % 120 })) }).success).toBe(false);
        expect(DeviceSnapshotWire.safeParse({ ...w, elements: [{ ...w.elements[0]!, text: "x".repeat(81) }] }).success).toBe(false);
        expect(DeviceSnapshotWire.safeParse({ ...w, screenshot: "A".repeat(DEVICE_MAX_IMAGE_B64 + 1) }).success).toBe(false);
        expect(DeviceSnapshotWire.safeParse({ ...w, screenshot: "A".repeat(DEVICE_MAX_IMAGE_B64) }).success).toBe(true);
    });

    it("commands: only a snapshot or a strictly shaped act; at most five per heartbeat", () => {
        expect(DeviceCommand.safeParse({ id: "d1", type: "snapshot", screenshot: true }).success).toBe(true);
        expect(DeviceCommand.safeParse({ id: "d2", type: "act", action: { kind: "tap", index: 3 } }).success).toBe(true);
        expect(DeviceCommand.safeParse({ id: "d3", type: "act", action: { kind: "tap", index: 3, x: 1 } }).success).toBe(false);
        expect(DeviceCommand.safeParse({ id: "d4", type: "act", action: { kind: "shell" } }).success).toBe(false);
        expect(DeviceCommand.safeParse({ id: "x".repeat(41), type: "snapshot", screenshot: false }).success).toBe(false);
        expect(DeviceCommand.safeParse({ id: "", type: "snapshot", screenshot: false }).success).toBe(false);
        const c = { id: "d1", type: "snapshot", screenshot: false };
        expect(HeartbeatResponse.safeParse({ cancel: false, leaseSeconds: 60, deviceCommands: [c, c, c, c, c] }).success).toBe(true);
        expect(HeartbeatResponse.safeParse({ cancel: false, leaseSeconds: 60, deviceCommands: [c, c, c, c, c, c] }).success).toBe(false);
    });

    it("pushes: capped and typed; capabilities and offers carry the new optional fields and an old reader loses nothing it knew", () => {
        expect(DevicePush.safeParse({ status: "ready", deviceName: "Pixel 7 (R58M)", results: [{ id: "d1", ok: true, snapshot: snapshotWire() }] }).success).toBe(true);
        expect(DevicePush.safeParse({ status: "starting", notes: Array.from({ length: 21 }, () => "x") }).success).toBe(false);
        expect(DevicePush.safeParse({ status: "weird" }).success).toBe(false);
        expect(DevicePush.safeParse({ status: "ready", results: Array.from({ length: 6 }, (_, i) => ({ id: `d${i}`, ok: true })) }).success).toBe(false);
        expect(Capabilities.parse({ os: "linux", arch: "x64", node: "v24", browsers: [], deviceSession: true }).deviceSession).toBe(true);
        expect(Capabilities.parse({ os: "linux", arch: "x64", node: "v24", browsers: [] }).deviceSession).toBeUndefined();
        const offer = { taskId: "t", jobId: "dev-1", adapterId: "device:a", leaseSeconds: 60, workers: 1, scripts: [], env: { baseUrl: "device:", headless: true }, kind: "device", device: { sessionId: "s1", appPackage: PKG, credentials: { password: "pw" } } };
        expect(CheckedTaskOffer.safeParse(offer).success).toBe(true);
        expect(TaskOffer.parse(offer).device).toMatchObject({ maxActions: 200, totalMinutes: 20 });
        expect(CheckedTaskOffer.safeParse({ ...offer, device: undefined }).success).toBe(false);
        expect(CheckedTaskOffer.safeParse({ ...offer, device: { sessionId: "s1", appPackage: "not a package" } }).success).toBe(false);
        expect(CheckedTaskOffer.safeParse({ ...offer, device: { sessionId: "s1", appPackage: PKG, avd: "x; rm" } }).success).toBe(false);
        // a task that is not a device task never needs the field
        expect(CheckedTaskOffer.safeParse({ ...offer, kind: undefined, device: undefined, scripts: [] }).success).toBe(false);
    });

    it("the device push is the seventh exact route", () => {
        const T = "11111111-2222-3333-4444-555555555555";
        expect(agentRouteOf("POST", `/api/agent/tasks/${T}/device`)).toEqual({ kind: "device", taskId: T });
        expect(isAgentRoute("POST", `/api/agent/tasks/${T}/device`)).toBe(true);
        for (const [m, p] of [["GET", `/api/agent/tasks/${T}/device`], ["POST", `/api/agent/tasks/${T}/device/`], ["POST", `/api/agent/tasks/${T}/Device`], ["POST", `/api/agent/tasks/${T}/device/x`], ["POST", `/api/agent/tasks/../device`], ["PUT", `/api/agent/tasks/${T}/device`]] as const) expect(isAgentRoute(m, p), `${m} ${p}`).toBe(false);
    });
});

describe("the agent re-checks every command", () => {
    const fakeSession = () => {
        const calls: string[] = [];
        const s = snap([el(0)]);
        return {
            calls,
            session: {
                snapshot: async (o?: { screenshot?: boolean }) => (calls.push(`snapshot:${o?.screenshot}`), s),
                act: async (a: DeviceAction) => (calls.push(`act:${a.kind}`), { ok: true, snapshot: s }),
            },
        };
    };

    it("answers a good command, and refuses a malformed one without touching the phone", async () => {
        const { calls, session } = fakeSession();
        expect(await answerDeviceCommand(session, { id: "d1", type: "snapshot", screenshot: false })).toMatchObject({ id: "d1", ok: true, snapshot: { package: PKG } });
        expect(await answerDeviceCommand(session, { id: "d2", type: "act", action: { kind: "tap", index: 0 } })).toMatchObject({ id: "d2", ok: true });
        for (const hostile of [
            { id: "d3", type: "act", action: { kind: "launch", package: "com.evil.app" } },
            { id: "d4", type: "act", action: { kind: "tap", index: 0, x: 10, y: 10 } },
            { id: "d5", type: "act", action: { kind: "adb", args: ["shell", "id"] } },
            { id: "d6", type: "run", command: "id" },
            { id: "d7", type: "act", action: { kind: "wait", ms: 99_999 } },
        ]) {
            const r = await answerDeviceCommand(session, hostile);
            expect(r, hostile.id).toMatchObject({ id: hostile.id, ok: false });
        }
        expect(await answerDeviceCommand(session, { type: "snapshot" })).toBeUndefined();
        expect(await answerDeviceCommand(session, "just text")).toBeUndefined();
        expect(calls).toEqual(["snapshot:false", "act:tap"]);
    });

    it("a phone that fails is thrown, not answered as a verdict", async () => {
        const failing = { snapshot: async () => { throw new DeviceSessionError("The phone is offline."); }, act: async () => ({ ok: true }) };
        await expect(answerDeviceCommand(failing, { id: "d1", type: "snapshot", screenshot: false })).rejects.toThrow("The phone is offline.");
    });
});

// ── where a phone session runs ──────────────────────────────────────────────

const caps = (over: Partial<AgentRecord["capabilities"]> = {}): AgentRecord["capabilities"] => ({ os: "linux", arch: "x64", node: "v24", browsers: [], android: { adb: true, devices: [{ serial: "R58M", state: "device", emulator: false }], avds: [] }, deviceSession: true, ...over });
const agent = (id: string, over: Partial<AgentRecord> & { online?: boolean; activeTasks?: number } = {}) => ({ id, name: `Agent ${id}`, capabilities: caps(), online: true, activeTasks: 0, ...over }) as unknown as AgentRecord & { online: boolean; activeTasks?: number };

describe("where a phone session runs (decision table)", () => {
    const platformRunner = { runOn: "platform" as const, agentId: null };
    const agentRunner = { runOn: "agent" as const, agentId: null };

    it("follows the project's runner choice unless told otherwise", () => {
        expect(chooseDeviceHost({ runner: platformRunner, agents: [agent("a")] })).toEqual({ kind: "platform" });
        expect(chooseDeviceHost({ runner: agentRunner, agents: [agent("a")] })).toMatchObject({ kind: "agent", agent: { id: "a" } });
        expect(chooseDeviceHost({ on: "platform", runner: agentRunner, agents: [agent("a")] })).toEqual({ kind: "platform" });
        expect(chooseDeviceHost({ on: "agent", runner: platformRunner, agents: [agent("a")] })).toMatchObject({ kind: "agent" });
    });

    it("refuses in plain words and names what is missing", () => {
        const throws = (fn: () => unknown) => { try { fn(); } catch (e) { return (e as { status: number; message: string }); } throw new Error("did not throw"); };
        expect(throws(() => chooseDeviceHost({ runner: platformRunner, agents: [], localProblem: "This computer has no Android tools." })).message).toContain("no Android tools");
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agents: [] })).message).toContain("No runner agent is online");
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agents: [agent("a", { online: false })] })).status).toBe(409);
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agentId: "zzz", agents: [agent("a")] })).status).toBe(404);
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agentId: "a", agents: [agent("a", { online: false })] })).message).toContain("offline");
        const noPhone = agent("n", { capabilities: caps({ deviceSession: undefined, android: { adb: true, devices: [], avds: [] } }) });
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agents: [noPhone] })).message).toContain("No phone is connected");
        const old = agent("o", { capabilities: caps({ deviceSession: undefined }) });
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agents: [old] })).message).toContain("too old");
        const noAndroid = agent("x", { capabilities: { os: "linux", arch: "x64", node: "v24", browsers: [] } });
        expect(throws(() => chooseDeviceHost({ runner: agentRunner, agentId: "x", agents: [noAndroid] })).status).toBe(422);
    });

    it("picks the least busy capable agent, and a pinned agent wins", () => {
        const busy = agent("busy", { activeTasks: 3 });
        const idle = agent("idle", { activeTasks: 0 });
        const incapable = agent("inc", { capabilities: caps({ deviceSession: undefined, android: { adb: false, devices: [], avds: [] } }), activeTasks: 0 });
        expect(chooseDeviceHost({ runner: agentRunner, agents: [busy, incapable, idle] })).toMatchObject({ agent: { id: "idle" } });
        expect(chooseDeviceHost({ runner: { runOn: "agent", agentId: "busy" }, agents: [busy, idle] })).toMatchObject({ agent: { id: "busy" } });
    });

    it("the capability rule gives a reason for each way a computer can fail", () => {
        expect(deviceSessionProblem({})).toContain("adb");
        expect(deviceSessionProblem({ android: { adb: false, devices: [], avds: ["a"] } })).toContain("adb");
        expect(deviceSessionProblem({ android: { adb: true, devices: [{ serial: "s", state: "unauthorized", emulator: false }], avds: [] } })).toContain("USB debugging");
        expect(deviceSessionProblem({ android: { adb: true, devices: [{ serial: "s", state: "offline", emulator: false }], avds: [] } })).toContain("offline");
        expect(deviceSessionProblem({ android: { adb: true, devices: [], avds: [] } })).toContain("No phone is connected");
        expect(deviceSessionProblem({ android: { adb: true, devices: [], avds: ["Pixel"] } })).toBeUndefined();
        expect(deviceSessionProblem({ android: { adb: true, devices: [{ serial: "s", state: "device", emulator: false }], avds: [] } })).toBeUndefined();
        expect(deviceProblem(agent("a"))).toBeUndefined();
        expect(isDeviceAdapter(deviceAdapterId("a1"))).toBe(true);
        expect(isDeviceAdapter("record:a1")).toBe(false);
    });
});

// ── what the agent sends back ───────────────────────────────────────────────

describe("what the agent sends back is made safe", () => {
    it("empties a password field's text, cleans texts, renumbers, recomputes the fingerprint and removes credentials", () => {
        const secret = "Project-Password-9f3a";
        const w = snapshotWire();
        const evil = { ...w.elements[1]!, text: `login ${secret} ${String.fromCharCode(7)}` };
        const pw = { ...w.elements[2]!, text: "typed-into-password", password: true };
        const cleaned = cleanDeviceSnapshot({ ...w, fingerprint: "claimed-by-the-agent", elements: [evil, pw, { ...w.elements[3]!, index: 99 }] }, [secret]);
        expect(JSON.stringify(cleaned)).not.toContain(secret);
        expect(cleaned.elements.map((e) => e.index)).toEqual([0, 1, 2]);
        expect(cleaned.elements[0]!.text).toBe("login [hidden]");
        expect(cleaned.elements[1]!.text).toBe("");
        expect(cleaned.fingerprint).toMatch(/^[0-9a-f]{16}$/);
        expect(cleaned.fingerprint).not.toBe("claimed-by-the-agent");
    });

    it("keeps a picture only when it is a JPEG in base64", () => {
        const w = snapshotWire();
        const jpeg = encodeJpeg(gradient(16, 16), 50).toString("base64");
        expect(cleanDeviceSnapshot({ ...w, screenshot: jpeg }, []).screenshot).toBe(jpeg);
        expect(cleanDeviceSnapshot({ ...w, screenshot: Buffer.from("<html>not a picture</html>").toString("base64") }, []).screenshot).toBeUndefined();
        expect(cleanDeviceSnapshot({ ...w, screenshot: "/9j/ not base64 !!" }, []).screenshot).toBeUndefined();
    });
});

// ── the remote driver's state machine ───────────────────────────────────────

function driverKit(over: { maxActions?: number; maxMinutes?: number } = {}) {
    let now = 1_000_000;
    let task: { status: "queued" | "running" | "done" | "failed" | "cancelled"; createdMs: number; claimedMs: number | null; cancelRequested: boolean } | undefined = { status: "queued", createdMs: now, claimedMs: null, cancelRequested: false };
    const cancelled: string[] = [];
    const deps: RemoteDeviceDeps = {
        clock: () => now,
        task: () => task,
        cancel: (id) => {
            cancelled.push(id);
            if (task && task.status === "queued") task = { ...task, status: "cancelled" };
            else if (task) task = { ...task, cancelRequested: true };
        },
        secrets: () => ["Project-Password-9f3a"],
    };
    const driver = new RemoteDeviceDriver(deps, { id: "s1", projectId: "p1", taskId: "t1", agent: { id: "a1", name: "Maya's laptop" }, maxActions: over.maxActions ?? 200, maxMinutes: over.maxMinutes ?? 20, timeouts: { commandWaitMs: 400, settleMs: 100, claimWaitMs: 60_000, lostContactMs: 45_000, startWaitMs: 5_000 } });
    return {
        driver, cancelled,
        advance: (ms: number) => (now += ms),
        claim: () => { task = { status: "running", createdMs: task!.createdMs, claimedMs: now, cancelRequested: false }; },
        setTask: (t: typeof task) => (task = t),
    };
}
const wireSnap = snapshotWire;

describe("the remote driver", () => {
    it("a task nobody claims fails with a plain message after the claim wait", async () => {
        const k = driverKit();
        k.advance(59_000);
        expect(k.driver.state.status).toBe("queued");
        k.advance(2_000);
        const s = k.driver.state;
        expect(s.status).toBe("failed");
        expect(s.error).toContain("did not start the phone session");
        expect(k.cancelled).toEqual(["t1"]);
        await expect(k.driver.waitReady()).rejects.toThrow(/did not start/);
    });

    it("becomes ready on the agent's word, then asks and is answered by command id", async () => {
        const k = driverKit();
        k.claim();
        k.driver.onPush({ status: "starting", notes: ["Starting the emulator"] });
        expect(k.driver.state).toMatchObject({ status: "starting", notes: ["Starting the emulator"] });
        k.driver.onPush({ status: "ready", deviceName: "Pixel 7 (R58M)" });
        await k.driver.waitReady();
        expect(k.driver.name).toBe("Pixel 7 (R58M)");

        const pending = k.driver.snapshot(true);
        await new Promise((r) => setTimeout(r, 20));
        const beat = k.driver.onHeartbeat();
        expect(beat.commands).toEqual([{ id: "d1", type: "snapshot", screenshot: true }]);
        // the command is repeated until it is answered, and an answer with another id is ignored
        expect(k.driver.onHeartbeat().commands).toHaveLength(1);
        k.driver.onPush({ status: "ready", results: [{ id: "zzz", ok: true, snapshot: wireSnap() }] });
        k.driver.onPush({ status: "ready", results: [{ id: "d1", ok: true, snapshot: { ...wireSnap(), fingerprint: "claimed" } }] });
        const s = await pending;
        expect(s.package).toBe(PKG);
        expect(s.fingerprint).not.toBe("claimed");
        expect(k.driver.onHeartbeat().commands).toEqual([]);
    });

    it("an action is checked here before it leaves, and an agent's refusal comes back as an ordinary result", async () => {
        const k = driverKit();
        k.claim();
        k.driver.onPush({ status: "ready", deviceName: "P" });
        // refused on the platform: no command is queued
        expect(await k.driver.act({ kind: "tap", index: -3 } as never, false)).toMatchObject({ ok: false });
        expect(k.driver.onHeartbeat().commands).toEqual([]);
        const a = k.driver.act({ kind: "tap", index: 0 }, false);
        await new Promise((r) => setTimeout(r, 20));
        expect(k.driver.onHeartbeat().commands[0]).toMatchObject({ type: "act", action: { kind: "tap", index: 0 } });
        k.driver.onPush({ status: "ready", results: [{ id: "d1", ok: false, error: "That element is not on the screen any more. Look at the screen again.", snapshot: wireSnap() }] });
        expect(await a).toMatchObject({ ok: false, error: expect.stringContaining("not on the screen"), snapshot: { package: PKG } });
    });

    it("an agent that stops answering ends the session with a plain error, never a verdict", async () => {
        const k = driverKit();
        k.claim();
        k.driver.onPush({ status: "ready", deviceName: "P" });
        await expect(k.driver.snapshot(false)).rejects.toThrow(/did not answer in time/);
        expect(k.driver.state.status).toBe("failed");
        expect(k.cancelled).toContain("t1");
        await expect(k.driver.snapshot(false)).rejects.toBeInstanceOf(DeviceSessionError);
    });

    it("loses contact: no push or heartbeat for 45 seconds ends the session", () => {
        const k = driverKit();
        k.claim();
        k.driver.onPush({ status: "ready" });
        k.advance(44_000);
        expect(k.driver.state.status).toBe("ready");
        k.driver.onHeartbeat();
        k.advance(44_000);
        expect(k.driver.state.status).toBe("ready");
        k.advance(2_000);
        expect(k.driver.state).toMatchObject({ status: "failed", error: expect.stringContaining("Lost contact with Maya's laptop") });
    });

    it("the agent can end it (ended, failed with a reason, a failed result), credentials are scrubbed from its words", async () => {
        const k = driverKit();
        k.claim();
        k.driver.onPush({ status: "ready" });
        k.driver.onPush({ status: "failed", error: "adb said Project-Password-9f3a is wrong" });
        expect(k.driver.state).toMatchObject({ status: "failed", error: "adb said [hidden] is wrong" });
        expect(() => k.driver.onPush({ status: "ready" })).toThrow(/already ended/);
        const k2 = driverKit();
        k2.claim();
        k2.driver.onPush({ status: "ready" });
        k2.driver.onResult({ ok: true });
        expect(k2.driver.state.status).toBe("ended");
    });

    it("closing tells the agent to give the task up, and the caps hold (actions, minutes)", async () => {
        const k = driverKit();
        k.claim();
        k.driver.onPush({ status: "ready" });
        const closing = k.driver.close();
        expect(k.driver.onHeartbeat().cancel).toBe(true);
        k.driver.onResult({ ok: true });
        await closing;
        expect(k.cancelled).toContain("t1");
        await expect(k.driver.act({ kind: "back" }, false)).rejects.toThrow(/has ended/);

        const capped = driverKit({ maxActions: 1 });
        capped.claim();
        capped.driver.onPush({ status: "ready" });
        const first = capped.driver.act({ kind: "back" }, false);
        await new Promise((r) => setTimeout(r, 20));
        capped.driver.onPush({ status: "ready", results: [{ id: "d1", ok: true, snapshot: wireSnap() }] });
        await first;
        await expect(capped.driver.act({ kind: "back" }, false)).rejects.toThrow(/limit of 1 actions/);

        const timed = driverKit({ maxMinutes: 1 });
        timed.claim();
        timed.driver.onPush({ status: "ready" });
        timed.advance(61_000);
        timed.driver.onHeartbeat();
        await expect(timed.driver.snapshot(false)).rejects.toThrow(/time limit of 1 minutes/);
    });
});
