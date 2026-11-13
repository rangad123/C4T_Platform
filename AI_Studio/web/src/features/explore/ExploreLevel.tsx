import { useEffect, useState } from "react";
import { api, type ProjectDetail } from "../../api";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import { LEVEL_SETTINGS, LEVELS, isLevel, type ExploreLevel } from "../../../../src/engine/levels";

const NAME: Record<ExploreLevel, string> = { thorough: "Thorough", deep: "Deep", everything: "Everything" };

/** One plain line per level, from the engine's own table (engine/levels.ts). */
export function levelLine(level: ExploreLevel): string {
    const s = LEVEL_SETTINGS[level];
    const base = `Up to ${s.maxPages} pages, ${s.maxDepth} clicks deep, about ${s.maxScenarios} tests from the AI.`;
    return level === "thorough"
        ? `${base} The default.`
        : `${base} Uses more AI and takes longer.${LEVEL_SETTINGS[level].visionByDefault ? " Includes the AI screen review when your model can read images: screenshots of key pages go to your AI provider." : ""}`;
}

/** The level a project's saved settings hold (thorough when none is saved). */
export function projectLevel(project: ProjectDetail | null | undefined): ExploreLevel {
    const l = project?.application?.config?.level;
    return isLevel(l) ? l : "thorough";
}

/** "How much to explore": Thorough, Deep or Everything, each with its line. */
export function LevelChoice({ value, onChange, name = "explore-level" }: { value: ExploreLevel; onChange: (l: ExploreLevel) => void; name?: string }) {
    return (
        <fieldset className="stack-sm" data-testid="explore-level">
            <legend className="t-section">How much to explore</legend>
            {LEVELS.map((l) => (
                <label className="row" key={l} style={{ alignItems: "flex-start" }}>
                    <input type="radio" name={name} value={l} checked={value === l} onChange={() => onChange(l)} />
                    <span>
                        <span className="t-card">{NAME[l]}</span>
                        <span className="t-meta" style={{ display: "block" }}>
                            {levelLine(l)}
                        </span>
                    </span>
                </label>
            ))}
        </fieldset>
    );
}

/**
 * "AI screen review" for one exploration. Its default comes from the level and whether the AI model can read images; `value` is
 * null until the person changes it, and only then is visionChecks sent (true or false), so an untouched box leaves it to the level.
 */
export function ScreenReviewChoice({ level, canReadImages, value, onChange }: { level: ExploreLevel; canReadImages: boolean; value: boolean | null; onChange: (v: boolean) => void }) {
    const checked = value ?? (LEVEL_SETTINGS[level].visionByDefault && canReadImages);
    return (
        <label className="row" style={{ alignItems: "flex-start" }}>
            <input type="checkbox" data-testid="screen-review" checked={checked} onChange={(e) => onChange(e.target.checked)} />
            <span>
                AI screen review (screenshots go to your AI provider)
                <span className="t-meta" style={{ display: "block" }}>
                    A model that can read images looks at key pages for overlapping or cut-off elements and broken pictures. On by default at Deep and Everything when your model can read images.
                </span>
            </span>
        </label>
    );
}

/** Project Settings → General: the level later explorations and schedules start from. */
export function ExploreLevelSetting({ id }: { id: string }) {
    const project = useFetch<ProjectDetail>(`/projects/${id}`);
    const saved = projectLevel(project.data);
    const [level, setLevel] = useState<ExploreLevel>(saved);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
    useEffect(() => setLevel(saved), [saved]);
    if (!project.data) return null;
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
            <LevelChoice value={level} onChange={(l) => (setLevel(l), setMsg(null))} name="project-explore-level" />
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
