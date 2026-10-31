/**
 * A scripted AI model for the tests of the AI phone explorer. It is never a real model: it answers the explorer's two questions from a script and
 * from what the prompt really contains (the numbered elements of the screen), so a test says "tap Sign in", not "tap element 3".
 *
 *  - an exploration turn is answered by the next intent of the script (a name on the screen to tap, text to type, back, finish...);
 *  - a planning question is answered by choosing every candidate the prompt lists, with the title the code proposed (or a function of the prompt).
 */
import type { LlmClient } from "../../src/engine/llm/provider.js";

export interface ParsedElement {
    index: number;
    cls: string;
    text: string;
    desc: string;
    id: string;
    flags: string;
}

/** The elements listed between the screen markers of an exploration prompt. */
export function parseScreen(prompt: string): ParsedElement[] {
    const block = /<screen untrusted-app-data>([\s\S]*?)<\/screen>/.exec(prompt)?.[1] ?? "";
    const out: ParsedElement[] = [];
    for (const line of block.split("\n")) {
        // Smaller screen descriptions (src/engine/snapshots/phone.ts): an element of a collapsed run is listed by number and name only
        // (no class), so this is read first.
        const c = /^\[(\d+)\](?: "([^"]*)")?(?: label "([^"]*)")?(?: \(no name\))?$/.exec(line.trim());
        if (c) {
            out.push({ index: Number(c[1]), cls: "", text: c[2] ?? "", desc: c[3] ?? "", id: "", flags: "" });
            continue;
        }
        const m = /^\[(\d+)\] (\S+)(?: "([^"]*)")?(?: label "([^"]*)")?(?: id=(\S+))?(?: \(([^)]*)\))?$/.exec(line.trim());
        if (m) out.push({ index: Number(m[1]), cls: m[2]!, text: m[3] ?? "", desc: m[4] ?? (m[3] ? "" : ""), id: m[5] ?? "", flags: m[6] ?? "" });
    }
    return out;
}

export type TurnAction = { kind: "tap"; index: number } | { kind: "type"; index: number; text: string } | { kind: "scroll"; direction: "up" | "down" | "left" | "right" } | { kind: "back" } | { kind: "hideKeyboard" } | { kind: "wait"; ms: number } | { kind: "finish" };

export type Intent =
    | { tap: string }
    | { type: string; text?: string }
    | { scroll: "up" | "down" }
    | { back: true }
    | { finish: true }
    | { raw: TurnAction }
    | { garbage: unknown }
    | ((els: ParsedElement[], prompt: string) => TurnAction | undefined);

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** An element by its name: exact first, then a name that starts with it ("Cart" finds "Cart, 0 items"), then a part of its resource id ("Password" finds password_field). */
const find = (els: ParsedElement[], name: string) => {
    const n = name.toLowerCase();
    return (
        els.find((e) => same(e.text, name) || same(e.desc, name) || same(e.id, name)) ??
        els.find((e) => e.text.toLowerCase().startsWith(`${n},`) || e.desc.toLowerCase().startsWith(`${n},`)) ??
        els.find((e) => e.id.toLowerCase().includes(n.replace(/\s+/g, "_")))
    );
};

export interface ScriptedPhoneModel extends LlmClient {
    turns: string[];
    plans: string[];
    /** Every system prompt it was given, in order. */
    systems: string[];
    calls: number;
}

export function scriptedPhoneModel(script: Intent[], o: { plan?: (prompt: string) => unknown; failPlan?: boolean } = {}): ScriptedPhoneModel {
    let next = 0;
    const model: ScriptedPhoneModel = {
        modelName: "scripted",
        model: {} as never,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: [],
        plans: [],
        systems: [],
        calls: 0,
        text: async () => "",
        object: (async ({ system, prompt }: { system: string; prompt: string }) => {
            model.calls++;
            model.systems.push(system);
            model.usage.inputTokens += 10;
            model.usage.outputTokens += 5;
            if (/choosing and naming test ideas/.test(system)) {
                model.plans.push(prompt);
                if (o.failPlan) return { nonsense: true };
                if (o.plan) return o.plan(prompt);
                const ideas = [...prompt.matchAll(/^(C\d+) \[(\w+)\] (.+?)\. Path:/gm)].map((m) => ({ id: m[1]!, title: m[3]!, goal: m[3]! }));
                return { ideas };
            }
            model.turns.push(prompt);
            const intent = script[next++];
            if (!intent) return { action: { kind: "finish" }, reason: "done" };
            const els = parseScreen(prompt);
            if (typeof intent === "function") return { action: intent(els, prompt) ?? { kind: "finish" }, reason: "scripted" };
            if ("garbage" in intent) return intent.garbage;
            if ("raw" in intent) return { action: intent.raw, reason: "scripted" };
            if ("finish" in intent) return { action: { kind: "finish" }, reason: "done" };
            if ("back" in intent) return { action: { kind: "back" }, reason: "scripted" };
            if ("scroll" in intent) return { action: { kind: "scroll", direction: intent.scroll }, reason: "scripted" };
            if ("tap" in intent) {
                const e = find(els, intent.tap);
                return { action: e ? { kind: "tap", index: e.index } : { kind: "back" }, reason: `tap ${intent.tap}` };
            }
            const e = find(els, intent.type);
            return { action: e ? { kind: "type", index: e.index, text: intent.text ?? "anything" } : { kind: "back" }, reason: `type ${intent.type}` };
        }) as LlmClient["object"],
    };
    return model;
}
