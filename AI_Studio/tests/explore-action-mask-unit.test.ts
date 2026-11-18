/**
 * The exploration action log as it is kept (CP2 M-2): typed values and opened addresses are masked when the log is written, so the job
 * summary, the stored artifact, a runner's exploration record and the coverage route never carry a secret the run typed or a query
 * string it opened. Placeholders and ordinary values stay readable. No browser.
 */
import { describe, expect, it } from "vitest";
import { maskAction, maskActionLog, TYPED_MAX } from "../src/engine/explore/action-mask.js";
import type { ActionLogRow } from "../src/engine/explore/loop.js";
import { actionTracker, boundedActionLog } from "../src/engine/orchestrator.js";

const KEY_LIKE = `sk-ant-api03-${"Zr4Q".repeat(10)}7`;
const row = (action: string, extra: Partial<ActionLogRow> = {}): ActionLogRow => ({ seq: 1, objectiveId: "OBJ-1:as_stated", state: "/login?next|abcdef012345", action, atMs: 0, result: "performed", ...extra });
const act = (tool: string, args: unknown) => `${tool} ${JSON.stringify(args)}`;

describe("maskAction", () => {
    it("drops an address's query string and fragment", () => {
        expect(maskAction(act("navigate", { url: "https://shop.test/reset?token=abc&x=1#access_token=zzz" }))).toBe(act("navigate", { url: "https://shop.test/reset" }));
        expect(maskAction(act("navigate", { url: "/cart?coupon=FREE" }))).toBe(act("navigate", { url: "/cart" }));
        // An address inside other text loses them too.
        expect(maskAction(act("wait", { until: "url", value: "x", why: "opens https://shop.test/a?sig=1 next" }))).not.toContain("sig=1");
    });

    it("hides a typed value that is a run secret, looks like one, or goes into a secret field; keeps placeholders and ordinary values", () => {
        const secrets = ["s3cr3t-Pass"];
        const fill = (label: string, value: string) => maskAction(act("fill", { target: { by: "label", value: label }, value }), secrets);
        expect(fill("Name", "s3cr3t-Pass")).not.toContain("s3cr3t-Pass");
        expect(fill("Notes", KEY_LIKE)).not.toContain("sk-ant");
        expect(fill("Password", "hunter22")).not.toContain("hunter22");
        expect(fill("One-time code", "123456")).not.toContain("123456");
        expect(fill("Password", "{{credentials.password}}")).toContain("{{credentials.password}}");
        expect(fill("Name", "Ada Lovelace")).toContain('"value":"Ada Lovelace"');
        // The field's own name stays: it is the element, not something typed.
        expect(fill("Password", "hunter22")).toContain('"target":{"by":"label","value":"Password"}');
    });

    it("cuts a long literal value", () => {
        const out = JSON.parse(maskAction(act("fill", { target: { by: "label", value: "Bio" }, value: "y".repeat(500) })).slice(5)) as { value: string };
        expect(out.value.length).toBeLessThanOrEqual(TYPED_MAX);
    });

    it("masks text that is not the usual shape as free text", () => {
        expect(maskAction(`odd text ${KEY_LIKE} https://a.test/?k=v`)).not.toMatch(/sk-ant|k=v/);
    });

    it("masking again changes nothing", () => {
        const once = maskActionLog([row(act("fill", { target: { by: "label", value: "Bio" }, value: "y".repeat(500) })), row(act("navigate", { url: `https://a.test/?k=${KEY_LIKE}` }))]);
        expect(maskActionLog(once)).toEqual(once);
    });
});

describe("the action log in the shape the engine writes it (CP3 N-2)", () => {
    const url = "https://shop.test/signup";
    /** The key the tracker hands the loop for a fill the test writer resolved to an element (author.ts: role, name, DOM digest). */
    const keyed = (target: string, label: string, value: string, secrets: string[] = []) =>
        actionTracker(url, secrets).before({ tool: "fill", args: { target: { by: "label", value: label }, value }, target, url }).action;

    it("a value typed into a field named like a secret one is never in the tracker's key", () => {
        for (const [name, value] of [["Password", "Hunt3r!pw22"], ["Create password", "Tr0ub4dor&3horse"], ["One-time code", "481516"], ["PIN", "7391"], ["API token", "tok-plain-55"]] as const) {
            const key = keyed(`textbox "${name}" @0a1b2c3d4e5f`, name, value);
            expect(key, name).not.toContain(value);
            expect(key, name).toContain(`textbox "${name}" @0a1b2c3d4e5f`);
        }
        // A field whose accessible name says nothing, but whose locator does.
        expect(actionTracker(url).before({ tool: "fill", args: { target: { by: "css", value: "input[type=password]" }, value: "Hunt3r!pw22" }, target: "textbox @0a1b2c3d4e5f", url }).action).not.toContain("Hunt3r!pw22");
        // The replayed step's own shape (`locator`, not `target`).
        expect(actionTracker(url).before({ tool: "fill", args: { action: "fill", locator: { by: "label", value: "PIN" }, value: "7391" }, target: 'textbox "PIN" @0a1b2c3d4e5f', url }).action).not.toContain("7391");
    });

    it("what is left of the arguments is masked: a key pressed into a secret field, a run secret, a value that looks like a key", () => {
        const t = (secrets: string[] = []) => actionTracker(url, secrets);
        expect(t().before({ tool: "press", args: { key: "7", target: { by: "label", value: "PIN" } }, target: 'textbox "PIN" @aa', url }).action).toBe('press textbox "PIN" @aa {"key":"[hidden]"}');
        expect(t().before({ tool: "press", args: { key: "Enter", target: { by: "label", value: "Quantity" } }, target: 'spinbutton "Quantity" @aa', url }).action).toBe('press spinbutton "Quantity" @aa {"key":"Enter"}');
        expect(t(["MyRunSecret9"]).before({ tool: "wait", args: { until: "text", value: "MyRunSecret9" }, url, read: true }).action).not.toContain("MyRunSecret9");
        expect(t().before({ tool: "wait", args: { until: "text", value: KEY_LIKE }, url, read: true }).action).not.toContain("sk-ant");
        expect(t().before({ tool: "wait", args: { until: "text", value: "Order placed" }, url, read: true }).action).toContain("Order placed");
    });

    it("maskAction masks a row already in that shape (a runner's record, masked again by the platform)", () => {
        const raw = (name: string, value: string) => `fill textbox ${JSON.stringify(name)} @0123456789ab ${JSON.stringify({ value })}`;
        expect(maskAction(raw("Create password", "Tr0ub4dor&3horse"))).toBe(`fill textbox "Create password" @0123456789ab {"value":"[hidden]"}`);
        expect(maskAction(raw("One-time code", "482913"))).not.toContain("482913");
        expect(maskAction(raw("PIN", "7391"))).not.toContain("7391");
        expect(maskAction(raw("Quantity", "5"))).toBe(raw("Quantity", "5"));
        // A name with braces in it is still the element's name, and a target without a value is kept as it is.
        expect(maskAction(raw('Pass {word}', "x-Secret-1"))).not.toContain("x-Secret-1");
        expect(maskAction('click button "Order" @0123456789ab')).toBe('click button "Order" @0123456789ab');
        const once = maskActionLog([row(raw("Password", "Hunt3r!pw22")), row(raw("Bio", "y".repeat(500)))]);
        expect(maskActionLog(once)).toEqual(once);
    });
});

describe("boundedActionLog", () => {
    it("keeps the rows masked with the run's secrets: action, reason and state", () => {
        const { actionLog } = boundedActionLog(
            [row(act("fill", { target: { by: "label", value: "Name" }, value: "MyRunSecret9" })), row(act("fill", { target: { by: "label", value: "Notes" }, value: KEY_LIKE }), { result: "refused", reason: `The same action again: ${KEY_LIKE}` })],
            ["MyRunSecret9"],
        );
        const text = JSON.stringify(actionLog);
        expect(text).not.toContain("MyRunSecret9");
        expect(text).not.toContain("sk-ant");
        expect(actionLog[0]!.state).toBe("/login?next|abcdef012345");
        expect(actionLog.map((r) => r.result)).toEqual(["performed", "refused"]);
    });
});
