/**
 * The two "no AI where it is not needed" savings (docs/features/repair-and-reuse-without-ai.md) and their switches:
 *   - repair without AI first (`LLM_DETERMINISTIC_REPAIR`): a test that could not find its element is tried with fixes worked out by plain
 *     comparison (the shared element's other locators, the same role and name, the same text, the element's own attributes); the model is
 *     asked only when none of them makes the test pass;
 *   - exploration reuse (`LLM_EXPLORATION_REUSE`): pages whose fingerprint did not change since the last exploration are not sent to the
 *     model again; what it understood about them then is used.
 * Both are on by default. A choice saved in Settings (AI model) wins over the environment, which wins over the default; the platform installs
 * where the saved choice is read (platform/without-ai-store.ts). The switch is read when the work starts, so a change applies to the next job.
 */
import type { Config } from "../../config.js";

export type WithoutAiSaving = "deterministicRepair" | "explorationReuse";
export type SavingSource = "app" | "environment" | "default";

export const SAVING_ENV: Record<WithoutAiSaving, "LLM_DETERMINISTIC_REPAIR" | "LLM_EXPLORATION_REUSE"> = {
    deterministicRepair: "LLM_DETERMINISTIC_REPAIR",
    explorationReuse: "LLM_EXPLORATION_REUSE",
};

/** An environment value: on unless it says off. */
export const envSwitch = (value: string | undefined): boolean => !/^\s*(false|off|0|no)\s*$/i.test(value ?? "");

let appSource: ((s: WithoutAiSaving) => boolean | undefined) | undefined;
/** Where the Settings choice is read (`undefined` from it: nobody chose in the app). */
export function setWithoutAiSource(fn: ((s: WithoutAiSaving) => boolean | undefined) | undefined): void {
    appSource = fn;
}

export function withoutAiSetting(cfg: Partial<Pick<Config, "LLM_DETERMINISTIC_REPAIR" | "LLM_EXPLORATION_REUSE">>, s: WithoutAiSaving): { enabled: boolean; source: SavingSource } {
    let fromApp: boolean | undefined;
    try {
        fromApp = appSource?.(s);
    } catch {
        fromApp = undefined;
    }
    if (fromApp !== undefined) return { enabled: fromApp, source: "app" };
    const env = cfg[SAVING_ENV[s]];
    if ((env ?? "").trim()) return { enabled: envSwitch(env), source: "environment" };
    return { enabled: true, source: "default" };
}

export const deterministicRepairOn = (cfg: Partial<Config> | undefined): boolean => withoutAiSetting(cfg ?? {}, "deterministicRepair").enabled;
export const explorationReuseOn = (cfg: Partial<Config> | undefined): boolean => withoutAiSetting(cfg ?? {}, "explorationReuse").enabled;

/** Job event kinds the savings write; the usage answer counts them (platform/routes/usage.ts). */
export const EVENT_REPAIRED_WITHOUT_AI = "repaired_without_ai";
export const EVENT_PAGES_REUSED = "understanding_reused";
