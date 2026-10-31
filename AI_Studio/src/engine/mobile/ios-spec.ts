/**
 * What an iOS test may contain. An iOS test is an ordinary mobile spec with `platform: "ios"`: it renders through the same
 * Taqwright generator as an Android test (same getBy* vocabulary), so the only differences are the ones the phone itself makes.
 * This file lists them as plain-word problems, so an import says exactly what is wrong instead of a test failing on the simulator.
 *
 *  - `press` with a keyboard key: iOS can press Enter, Tab, Backspace, the arrow keys and Escape. Android's other keys do not exist.
 *  - `device:back`: iOS has no global back button. Taqwright performs a swipe from the left edge instead (what people do with a thumb),
 *    which works in apps with standard navigation and does nothing in others. The script is the same text as on Android.
 *  - `device:home`, `device:scroll:<direction>`, `device:swipe:<direction>`, `device:scroll-into-view` work as on Android.
 */
import type { Step, TestSpec } from "../spec/schema.js";

/** The keys Taqwright can press on iOS (its own table; anything else throws on the simulator). */
export const IOS_KEYS = ["Enter", "Tab", "Backspace", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Escape"] as const;

const DIRECTIONS = new Set(["up", "down", "left", "right"]);

function pressProblem(step: Extract<Step, { action: "press" }>, n: number): string | undefined {
    const device = /^device:([a-z-]+)(?::([a-z]+))?$/.exec(step.key);
    if (device) {
        const [, what, dir] = device;
        if ((what === "back" || what === "home") && !dir) return undefined;
        if ((what === "scroll" || what === "swipe") && dir && DIRECTIONS.has(dir)) return undefined;
        if (what === "scroll-into-view" && !dir && step.locator) return undefined;
        return `Step ${n}: "${step.key}" is not a device action. Use device:back, device:home, device:scroll:<up|down|left|right>, device:swipe:<up|down|left|right> or device:scroll-into-view (with a locator).`;
    }
    if (!(IOS_KEYS as readonly string[]).includes(step.key)) return `Step ${n}: iOS can't press the key "${step.key}". It understands ${IOS_KEYS.join(", ")}.`;
    return undefined;
}

/** Plain-word problems that make a spec unusable as an iOS test. Empty = fine. A spec that is not marked iOS is checked only for a stray `platform`. */
export function iosSpecIssues(spec: Pick<TestSpec, "kind" | "steps"> & { platform?: string }): string[] {
    const out: string[] = [];
    if (spec.platform === undefined) return out;
    if (spec.kind !== "mobile") {
        out.push("Only mobile tests have a platform.");
        return out;
    }
    if (spec.platform !== "ios") return out;
    spec.steps.forEach((s, i) => {
        if (s.action === "press") {
            const why = pressProblem(s, i + 1);
            if (why) out.push(why);
        }
    });
    return out;
}
