import { Fragment, type ReactNode } from "react";
import { routes } from "../../lib/router";
import { glossary, topics } from "./content";
import { OpenInApp } from "./current-project";
import type { GlossaryEntry, GuideStep, Topic } from "./types";

export const topicById = (id: string): Topic | undefined => topics.find((t) => t.id === id);
export const wordById = (id: string): GlossaryEntry | undefined => glossary.find((g) => g.id === id);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A step with the on-screen names in bold, so a person can match them to the buttons they see. */
export function StepText({ step }: { step: GuideStep }) {
    const names = [...(step.ui ?? [])].filter(Boolean).sort((a, b) => b.length - a.length);
    if (names.length === 0) return <>{step.text}</>;
    const parts = step.text.split(new RegExp(`(${names.map(escapeRe).join("|")})`));
    return (
        <>
            {parts.map((p, i) => (names.includes(p) ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p}</Fragment>))}
        </>
    );
}

/**
 * One topic, in the same order everywhere: what it is, why, how (numbered), good to know, the button into the app, the words,
 * related topics, and where the technical detail is. `level` is the heading level of the title (1 on the Guide page, 3 in the panel).
 * With `onTopic`, related topics are buttons that stay where they are (the panel); without it they are links to the topic's page.
 */
export function TopicView({ topic, level, onTopic }: { topic: Topic; level: 1 | 3; onTopic?: (id: string) => void }) {
    const H = (level === 1 ? "h1" : "h3") as "h1" | "h3";
    const Sub = (level === 1 ? "h2" : "h4") as "h2" | "h4";
    const words = (topic.words ?? []).map(wordById).filter((w): w is GlossaryEntry => Boolean(w));
    const related = (topic.related ?? []).map(topicById).filter((t): t is Topic => Boolean(t));
    const section = (title: string, body: ReactNode) => (
        <section className="guide-sec">
            <Sub className="guide-sub">{title}</Sub>
            {body}
        </section>
    );
    return (
        <article className="guide-topic" aria-labelledby={`topic-${topic.id}`}>
            <H className={level === 1 ? "t-page" : "t-section"} id={`topic-${topic.id}`}>
                {topic.title}
            </H>
            {section("What it is", <p>{topic.what}</p>)}
            {section("Why you’d use it", <p>{topic.why}</p>)}
            {topic.steps.length > 0 &&
                section(
                    "How",
                    <ol className="guide-steps">
                        {topic.steps.map((s, i) => (
                            <li key={i}>
                                <StepText step={s} />
                            </li>
                        ))}
                    </ol>,
                )}
            {topic.goodToKnow && topic.goodToKnow.length > 0 &&
                section(
                    "Good to know",
                    <ul className="guide-list">
                        {topic.goodToKnow.map((g, i) => (
                            <li key={i}>{g}</li>
                        ))}
                    </ul>,
                )}
            {topic.open && (
                <div className="guide-open">
                    <OpenInApp label={topic.open.label} to={topic.open.to} />
                </div>
            )}
            {words.length > 0 &&
                section(
                    "Words in this topic",
                    <dl className="guide-words">
                        {words.map((w) => (
                            <Fragment key={w.id}>
                                <dt>{w.term}</dt>
                                <dd>{w.meaning}</dd>
                            </Fragment>
                        ))}
                    </dl>,
                )}
            {related.length > 0 &&
                section(
                    "Related topics",
                    <ul className="guide-list guide-related">
                        {related.map((r) => (
                            <li key={r.id}>{onTopic ? <button type="button" className="btn-link" onClick={() => onTopic(r.id)}>{r.title}</button> : <a href={routes.guideTopic(r.id)}>{r.title}</a>}</li>
                        ))}
                    </ul>,
                )}
            {topic.moreDoc && (
                <details className="guide-more">
                    <summary>More technical detail</summary>
                    <p>
                        The repository has a longer, more technical note: <code className="mono">{topic.moreDoc}</code>
                    </p>
                </details>
            )}
        </article>
    );
}
