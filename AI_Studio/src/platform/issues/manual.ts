/**
 * The issue made from a failed manual check. Built from the same neutral blocks as an automated finding, so GitHub and Jira
 * render it with their own markup. Everything a person typed goes into code blocks, never into running text: a tracker then
 * shows it as plain text and cannot be made to link, mention or format anything from it.
 */
import { RESULT_LABEL } from "../../engine/manual/cases.js";
import type { ViewItem } from "../manual-releases.js";
import type { Block, IssueDraft } from "./content.js";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildManualIssueDraft(a: { item: ViewItem; releaseName: string; projectName: string; releaseUrl: string }): IssueDraft {
    const { item } = a;
    const title = clip(`[Manual check failed] ${item.title}`.replace(/\s+/g, " "), 240);
    const details = [
        `Check: ${item.title}`,
        `Area: ${item.area}`,
        `Priority: ${item.priority}`,
        `Result: ${RESULT_LABEL[item.result]}${item.by ? `, recorded by ${item.by}` : ""}`,
        `Release: ${a.releaseName}`,
        `Project: ${a.projectName}`,
        ...(item.requirement ? [`Requirement: ${item.requirement}`] : []),
    ].join("\n");
    const steps = item.steps.length
        ? item.steps.map((s, i) => `${i + 1}. ${s.action}${s.expected ? `\n   Expected: ${s.expected}` : ""}`).join("\n")
        : "This check has no written steps.";

    const blocks: Block[] = [
        { t: "heading", text: "What failed" },
        { t: "paragraph", text: "A person ran this manual check during a release and it failed." },
        ...(item.note ? ([{ t: "heading", text: "Note from the tester" }, { t: "code", text: clip(item.note, 1500) }] as Block[]) : []),
        { t: "heading", text: "Details" },
        { t: "code", text: clip(details, 2000) },
        { t: "heading", text: "Steps" },
        { t: "code", text: clip(steps, 4000) },
        { t: "link", label: "Open this release in the AI Testing Platform", url: a.releaseUrl },
        { t: "paragraph", text: "Created automatically by the AI Testing Platform." },
    ];
    return { title, labels: ["ai-testing", "manual-check", `priority-${item.priority}`], blocks };
}
