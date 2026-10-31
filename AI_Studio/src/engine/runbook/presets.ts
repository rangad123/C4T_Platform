/**
 * Starting points for a new runbook. A preset is only a definition; creating one goes through exactly the same validation and
 * storage as a runbook written by hand. Presets that tell the team need an alert channel; without one they are built without
 * the message step (and the answer says so), so a project with no channel can still use them.
 */
import { parseDefinition, type RunbookDefinition, type Step } from "./schema.js";

export interface Preset {
    id: "smoke-then-full" | "release-gate" | "nightly-with-alert";
    name: string;
    /** One sentence for the button's description. */
    summary: string;
    /** Does the runbook include a message to the team when a channel is given? */
    usesChannel: boolean;
}

export const PRESETS: Preset[] = [
    { id: "smoke-then-full", name: "Smoke then full run", summary: "Run the quick smoke tests first. If they pass, run everything; if they fail, tell the team and stop.", usesChannel: true },
    { id: "release-gate", name: "Release gate", summary: "Run everything, then check the pass rate, the findings, the API and the project’s readiness, and tell the team the verdict.", usesChannel: true },
    { id: "nightly-with-alert", name: "Nightly with alert", summary: "Run all tests; tell the team only if something fails. Pair it with a nightly schedule.", usesChannel: true },
];

export function isPresetId(id: string): id is Preset["id"] {
    return PRESETS.some((p) => p.id === id);
}

/** The definition of a preset, with the message step only when a channel is given. */
export function presetDefinition(id: Preset["id"], channelId?: string): RunbookDefinition {
    const preset = PRESETS.find((p) => p.id === id)!;
    const tell = (message: string): Step[] => (channelId ? [{ id: "tell", type: "notify", title: "Tell the team", channelId, message }] : []);
    let steps: Step[];

    if (id === "smoke-then-full") {
        steps = [
            { id: "smoke", type: "run", title: "Run the smoke tests", scope: { type: "smoke" }, retries: 1, ...(channelId ? { onFail: "tell" } : {}) },
            { id: "everything", type: "run", title: "Run all tests", scope: "all", retries: 1, ...(channelId ? { onPass: "stop", onFail: "tell" } : {}) },
            ...tell("{{project}}: the run {{status}}. {{passRate}} passed, {{failed}} failing. {{runUrl}}"),
        ];
    } else if (id === "release-gate") {
        const to = channelId ? "tell" : undefined;
        steps = [
            { id: "everything", type: "run", title: "Run all tests", scope: "all", retries: 1, ...(to ? { onFail: to } : {}) },
            { id: "rate", type: "condition", condition: { check: "passRate", atLeast: 95 }, ...(to ? { onFail: to } : {}) },
            { id: "severity", type: "condition", condition: { check: "noHighSeverity" }, ...(to ? { onFail: to } : {}) },
            { id: "api", type: "condition", condition: { check: "noApiBreakingChange" }, ...(to ? { onFail: to } : {}) },
            { id: "ready", type: "condition", condition: { check: "readiness" }, ...(to ? { onFail: to } : {}) },
            ...tell("Release gate for {{project}}: {{status}}. {{passRate}} passed, {{failed}} failing. {{runUrl}}"),
        ];
    } else {
        steps = [
            { id: "nightly", type: "run", title: "Run all tests", scope: "all", retries: 1, ...(channelId ? { onPass: "stop", onFail: "tell" } : {}) },
            ...tell("{{project}}: tonight’s run {{status}}. {{passRate}} passed, {{failed}} failing. {{runUrl}}"),
        ];
    }

    const parsed = parseDefinition({ version: 1, name: preset.name, description: preset.summary, steps });
    // A preset is code, not input: if it ever stops being valid that is a bug to find in tests, not something to hide.
    if (!parsed.ok) throw new Error(`Runbook preset ${id} is not valid: ${parsed.errors[0]?.message}`);
    return parsed.definition;
}
