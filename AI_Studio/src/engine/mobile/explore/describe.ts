/**
 * The compact description of the current screen the model reads each turn: the elements by number, what changed since the last action, the screens
 * already visited, the path taken and what is left of the budget. Everything the app wrote goes through the cleaner and sits inside one delimited block.
 */
import type { ScreenElement, ScreenSnapshot } from "../device/types.js";
import { compactScreenLines } from "../../snapshots/phone.js";
import { SCREEN_CLOSE, SCREEN_OPEN } from "./prompts.js";
import { cleanAppText, scrubSecrets } from "./text.js";

/** Largest description sent (characters); the elements are cut to fit, never the rules. */
export const MAX_DESCRIPTION = 7000;
export const MAX_LISTED = 80;

export interface DescribeInput {
    appPackage: string;
    snapshot: ScreenSnapshot;
    screenId: string;
    isNew: boolean;
    visited: ReadonlyArray<{ id: string; title: string }>;
    /** The last few things done, as plain lines. */
    path: readonly string[];
    changed: string;
    /** Actions the platform refused earlier in this same turn: the model must not ask for them again. */
    refused: readonly string[];
    budget: { actions: number; minutes: number; screens: number };
    allowDataChanges: boolean;
    credentialsGiven: boolean;
    secrets: readonly string[];
    /** Smaller screen descriptions (setting LLM_COMPACT_SNAPSHOTS, snapshots/phone.ts). Unset or false: exactly the description of before. */
    compact?: boolean;
}

const KIND: Record<string, string> = { EditText: "text field", CheckBox: "checkbox", Switch: "switch", RadioButton: "radio button", Spinner: "dropdown", ToggleButton: "toggle" };

function line(e: ScreenElement, secrets: readonly string[]): string {
    const clean = (s: string, n: number) => cleanAppText(scrubSecrets(s, secrets), n);
    const bits: string[] = [];
    const kind = e.password ? "password field" : (KIND[e.cls] ?? (e.editable ? "text field" : undefined));
    if (kind) bits.push(kind);
    if (e.checkable) bits.push(e.checked ? "checked" : "not checked");
    if (e.scrollable) bits.push("scrollable");
    if (!e.enabled) bits.push("disabled");
    if (!e.clickable && !e.editable && !e.scrollable && !e.checkable) bits.push("label only");
    const text = e.password ? "" : clean(e.text, 60);
    const desc = clean(e.desc, 60);
    const name = text || desc;
    const parts = [`[${e.index}] ${clean(e.cls, 24) || "View"}`];
    if (name) parts.push(`"${name}"`);
    if (text && desc && desc !== text) parts.push(`label "${desc}"`);
    if (e.id) parts.push(`id=${clean(e.id, 40)}`);
    if (bits.length) parts.push(`(${bits.join(", ")})`);
    return parts.join(" ");
}

export function describeScreen(i: DescribeInput): string {
    const s = i.snapshot;
    const head = [
        `App under test: ${i.appPackage}`,
        `Budget left: ${i.budget.actions} actions, ${i.budget.minutes} minutes, room for ${i.budget.screens} more screens.`,
        `Changing data is ${i.allowDataChanges ? "allowed" : "NOT allowed"}. Sign-in details were ${i.credentialsGiven ? "given" : "NOT given"}.`,
        i.visited.length ? `Screens visited (${i.visited.length}): ${i.visited.slice(0, 25).map((v) => `${v.id} ${cleanAppText(v.title, 30)}`).join("; ")}` : "Screens visited: none yet",
        i.path.length ? `Last steps: ${i.path.slice(-8).join(" > ")}` : "Last steps: none yet",
        `This is screen ${i.screenId}${i.isNew ? " (new)" : " (visited before)"}. ${i.changed}`,
    ];
    if (i.refused.length) head.push(`Not allowed on this screen, do not ask again: ${i.refused.slice(-6).join("; ")}`);

    const block = [SCREEN_OPEN, `activity: ${cleanAppText(s.activity ?? "", 80) || "unknown"}`, `keyboard: ${s.keyboard ? "showing" : "hidden"}`];
    const used = head.join("\n").length + 200;
    let room = Math.max(500, MAX_DESCRIPTION - used);
    let listed = 0;
    if (i.compact) {
        // Decorations left out and look-alike runs shortened, so more of a long screen fits; numbers and names are unchanged.
        const { lines, dropped } = compactScreenLines(s.elements.map((e) => line(e, i.secrets)));
        for (const l of lines) {
            if (listed >= MAX_LISTED || l.text.length + 1 > room) break;
            block.push(l.text);
            room -= l.text.length + 1;
            listed += l.elements;
        }
        if (listed + dropped < s.elements.length) block.push(`(${s.elements.length - listed - dropped} more elements not listed)`);
        block.push(SCREEN_CLOSE);
        return `${head.join("\n")}\n${block.join("\n")}\nChoose the next action.`;
    }
    for (const e of s.elements.slice(0, MAX_LISTED)) {
        const l = line(e, i.secrets);
        if (l.length + 1 > room) break;
        block.push(l);
        room -= l.length + 1;
        listed++;
    }
    if (listed < s.elements.length) block.push(`(${s.elements.length - listed} more elements not listed)`);
    block.push(SCREEN_CLOSE);
    return `${head.join("\n")}\n${block.join("\n")}\nChoose the next action.`;
}

/** One sentence on what the last action changed, from facts. */
export function changedSince(before: ScreenSnapshot | undefined, after: ScreenSnapshot, sameScreen: boolean, secrets: readonly string[] = []): string {
    if (!before) return "This is the first screen.";
    if (!sameScreen) return "The last action opened a different screen.";
    const was = new Set(before.elements.map((e) => `${e.id}|${e.text}|${e.desc}`));
    const added = after.elements.filter((e) => !e.password && !was.has(`${e.id}|${e.text}|${e.desc}`) && (e.text || e.desc));
    if (!added.length) return "The last action changed nothing visible.";
    return `The last action changed this screen; new: ${added.slice(0, 4).map((e) => `"${cleanAppText(scrubSecrets(e.text || e.desc, secrets), 40)}"`).join(", ")}.`;
}
