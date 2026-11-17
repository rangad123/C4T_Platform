import type { MutableRefObject } from "react";
import { Callout, Disclosure, LinkButton, Term } from "../../components/ui";
import { PlainOrigin } from "../authoring/PlainOrigin";
import { descriptionOf } from "../authoring/authoring";
import { StepsEditor, type EditorEmbed } from "../builder/BuilderPage";
import { testTabHref, type Detail, type StepMark } from "./test-model";

/** The controls list is only useful where a test is about security, accessibility or access: elsewhere the mapping is generic ("applies to everything"). */
const COMPLIANCE_TYPES = new Set(["security", "accessibility"]);
const COMPLIANCE_ORIGINS = new Set(["security-check", "a11y-audit", "access-check"]);

export interface EditorProps {
    mode: "steps" | "text";
    active: boolean;
    barSlot: HTMLElement | null;
    marks: Array<StepMark | undefined> | undefined;
    onMode: EditorEmbed["onMode"];
    onDirty: EditorEmbed["onDirty"];
    onSaved: EditorEmbed["onSaved"];
    onReload: EditorEmbed["onReload"];
    switchRef: MutableRefObject<((mode: "steps" | "text") => Promise<boolean>) | null>;
}

/**
 * The Steps tab: what the test checks (in a sentence), then the step editor with the last run's marks on each step. The script
 * shows only on the Code tab; a link here leads to it. Steps and Text are two views of one editor, so unsaved work in either survives
 * a switch between them (and a visit to the other tabs). A code test has no steps: one callout points to the Code tab, like the DSL
 * tab's.
 */
export function StepsTab({ test, editor, onChanged, refreshKey }: { test: Detail; editor: EditorProps; onChanged: () => void; refreshKey: number }) {
    const t = test;
    const embed: EditorEmbed = { ...editor };
    const about = editor.mode === "steps";
    if (t.custom) {
        return (
            <Callout
                tone="info"
                title="This test is code only: it has no steps"
                actions={
                    <LinkButton size="sm" variant="primary" href={testTabHref(t.id, "code")}>
                        Open the Code tab
                    </LinkButton>
                }
            >
                It was written as code, so there are no steps to show or edit. The code is the test: read or change it in the Code tab{t.custom.canRestoreGenerated ? ", or go back to the generated version there to get the steps back" : ""}.
            </Callout>
        );
    }
    return (
        <div className="stack">
            {about && (
                <section className="stack-sm" aria-labelledby="wb-what">
                    <h2 className="t-section" id="wb-what">
                        What this test checks
                    </h2>
                    {t.spec.source?.origin === "plain-english" ? (
                        <PlainOrigin testId={t.id} projectId={t.projectId} description={descriptionOf(t.generationMeta, t.spec.description)} onRebuilt={onChanged} />
                    ) : (
                        t.spec.description && <p className="t-secondary">{t.spec.description}</p>
                    )}
                    {t.quality?.level === "weak" && (
                        <Callout tone="neutral" title="This test checks very little">
                            <ul className="bullets" data-testid="quality-reasons">
                                {t.quality.reasons.map((r, i) => (
                                    <li key={i}>{r}</li>
                                ))}
                            </ul>
                            Add a check for what the feature should do: add a step below that checks it.
                        </Callout>
                    )}
                    {t.controls?.length && (COMPLIANCE_TYPES.has(t.type) || COMPLIANCE_ORIGINS.has(t.spec.source?.origin ?? "")) ? (
                        <Disclosure label="Compliance">
                            <p className="t-secondary" style={{ marginBottom: 6 }} data-testid="controls">
                                This test maps to these <Term word="control">controls</Term>, so it counts as evidence for them: {t.controls.map((c) => `${c.title} (${c.id})`).join(", ")}. The mapping is indicative, not an assessment.
                            </p>
                        </Disclosure>
                    ) : null}
                    {t.dataDriven && (
                        <p className="t-meta" data-testid="data-driven">
                            Runs once for each row of the test data “{t.dataDriven.dataSet}”
                            {t.dataDriven.found ? ` (${t.dataDriven.rows} ${t.dataDriven.rows === 1 ? "row" : "rows"})` : ", which no longer exists, so it can’t run"}.
                            {t.dataDriven.note ? ` ${t.dataDriven.note}` : ""}
                        </p>
                    )}
                    {(t.spec.preconditions.length > 0 || t.spec.expectedResults.length > 0) && (
                        <Disclosure label="Before it runs and what it expects">
                            <div className="stack-sm">
                                {t.spec.preconditions.length > 0 && (
                                    <div>
                                        <h3 className="t-card" style={{ margin: "0 0 4px" }}>Before it runs</h3>
                                        <ul className="bullets">
                                            {t.spec.preconditions.map((p, i) => (
                                                <li key={i}>{p}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                                {t.spec.expectedResults.length > 0 && (
                                    <div>
                                        <h3 className="t-card" style={{ margin: "0 0 4px" }}>Expected result</h3>
                                        <ul className="bullets">
                                            {t.spec.expectedResults.map((p, i) => (
                                                <li key={i}>{p}</li>
                                            ))}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </Disclosure>
                    )}
                </section>
            )}
            <StepsEditor id={t.id} embed={embed} refreshKey={refreshKey} title={t.title} />
        </div>
    );
}
