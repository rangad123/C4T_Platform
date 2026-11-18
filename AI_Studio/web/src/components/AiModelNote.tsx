import { Callout } from "./ui";

/**
 * What an AI route says when the project's AI model is not one of the person's own and their default AI was used instead (`aiNote`
 * in the answer, src/platform/ai-config.ts aiNoteOf). Shown with the result of the action: nothing when the answer has no note.
 */
export function AiModelNote({ note }: { note?: string | null }) {
    if (!note) return null;
    return (
        <div data-testid="ai-model-note">
            <Callout tone="warning">{note}</Callout>
        </div>
    );
}
