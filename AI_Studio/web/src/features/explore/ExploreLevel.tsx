import { useEffect, useState } from "react";
import { api, projectKind, projectShape, type ProjectDetail } from "../../api";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import type { ProjectAgents } from "../testing-agents/testing-agents";
import { LEVEL_SETTINGS, LEVELS, isLevel, type ExploreLevel } from "../../../../src/engine/levels";

const NAME: Record<ExploreLevel, string> = { thorough: "Thorough", deep: "Deep", everything: "Everything" };

/** One plain line per level, from the engine's own table (engine/levels.ts). `caseAgent`: a Test Case Generation project, which writes test cases. */
export function levelLine(level: ExploreLevel, caseAgent = false): string {
    const s = LEVEL_SETTINGS[level];
    const base = caseAgent
        ? `Up to ${s.maxPages} pages in the tree, ${s.maxDepth} clicks deep, about ${s.maxScenarios} test cases from the AI.`
        : `Up to ${s.maxPages} pages, ${s.maxDepth} clicks deep, about ${s.maxScenarios} tests from the AI.`;
    // A Test Case Generation project has no screen review (P4.1; its exploration turns it off).
    return level === "thorough"
        ? `${base} The default.`
        : `${base} Uses more AI and takes longer.${s.visionByDefault && !caseAgent ? " Includes the AI screen review when your model can read images: screenshots of key pages go to your AI provider." : ""}`;
}

/** The level a project's saved settings hold (thorough when none is saved). */
export function projectLevel(project: ProjectDetail | null | undefined): ExploreLevel {
    const l = project?.application?.config?.level;
    return isLevel(l) ? l : "thorough";
}

/** "How much to explore": Thorough, Deep or Everything, each with its line. */
export function LevelChoice({ value, onChange, name = "explore-level", caseAgent = false }: { value: ExploreLevel; onChange: (l: ExploreLevel) => void; name?: string; caseAgent?: boolean }) {
    return (
        <fieldset className="stack-sm" data-testid="explore-level" style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
            <legend className="t-section">How much to explore</legend>
            {LEVELS.map((l) => (
                <label className="check" key={l}>
                    <input type="radio" name={name} value={l} checked={value === l} onChange={() => onChange(l)} />
                    <span>
                        <span className="title">{NAME[l]}</span>
                        <span className="hint">{levelLine(l, caseAgent)}</span>
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

/**
 * "AI screen review" for one exploration, shown only at a level that includes it (Deep, Everything) with a model that can read images.
 * `value` is null until the person changes it, and only then is visionChecks sent, so an untouched box leaves it to the level.
 */
export function ScreenReviewChoice({ level, canReadImages, value, onChange }: { level: ExploreLevel; canReadImages: boolean; value: boolean | null; onChange: (v: boolean) => void }) {
    const checked = value ?? (LEVEL_SETTINGS[level].visionByDefault && canReadImages);
    return (
        <label className="check">
            <input type="checkbox" data-testid="screen-review" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>
                <span className="title">AI screen review (screenshots go to your AI provider)</span>
                <span className="hint">A model that can read images looks at key pages for overlapping or cut-off elements and broken pictures. This level includes it; untick it to keep the screenshots from your AI provider.</span>
            </span>
        </label>
    );
}

/**
 * Project Settings → General: the level later explorations and schedules start from. Not shown for a project that tests only a phone
 * app (phone explorations have their own "How thorough" under Settings → Mobile app, and this level is not read there), nor for a
 * code project, which never explores. A project tested by both the AI agent and code keeps it.
 */
export function ExploreLevelSetting({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    // A Test Case Generation project's levels count test cases (the server's rule, FX14).
    const agents = useFetch<ProjectAgents>(`/projects/${id}/testing-agents`);
    const saved = projectLevel(project.data);
    const [level, setLevel] = useState<ExploreLevel>(saved);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
    useEffect(() => setLevel(saved), [saved]);
    if (!project.data) return null;
    if (!projectShape(project.data).platforms.includes("web") || projectKind(project.data) === "code") return null;
    async function save() {
        setBusy(true);
        setMsg(null);
        try {
            await api(`/projects/${id}/explore-level`, { method: "PUT", body: { level } });
            setMsg({ ok: true, text: `Later explorations and schedules explore at ${NAME[level]}.` });
            project.reload();
        } catch (e) {
            setMsg({ ok: false, text: describeApiError(e) });
        } finally {
            setBusy(false);
        }
    }
    return (
        <div className="card card-pad stack-sm" data-testid="explore-level-setting">
            <LevelChoice value={level} onChange={(l) => (setLevel(l), setMsg(null))} name="project-explore-level" caseAgent={agents.data?.caseAgent === true} />
            {!project.data.application && <p className="t-meta">Saved once the application has been explored for the first time.</p>}
            {msg && <Callout tone={msg.ok ? "success" : "danger"}>{msg.text}</Callout>}
            <div>
                <Button variant="primary" loading={busy} disabled={!project.data.application || level === saved} onClick={() => void save()}>
                    Save
                </Button>
            </div>
        </div>
    );
}
