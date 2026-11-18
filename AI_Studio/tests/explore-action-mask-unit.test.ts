/**
 * The exploration action log as it is kept (CP2 M-2): typed values and opened addresses are masked when the log is written, so the job
 * summary, the stored artifact, a runner's exploration record and the coverage route never carry a secret the run typed or a query
 * string it opened. Placeholders and ordinary values stay readable. No browser.
 */
import { describe, expect, it } from "vitest";
import { maskAction, maskActionLog, TYPED_MAX } from "../src/engine/explore/action-mask.js";
import type { ActionLogRow } from "../src/engine/explore/loop.js";
import { boundedActionLog } from "../src/engine/orchestrator.js";

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
