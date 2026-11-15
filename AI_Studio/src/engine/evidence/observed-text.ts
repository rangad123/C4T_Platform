/**
 * Text the application put in front of the browser while the AI works (console errors, page errors, failed requests, dialog messages)
 * is masked before it goes anywhere: into an authoring prompt, an agent action's observation, a defect's evidence. The same masker the
 * stored evidence uses (capture.ts evidenceText): the run's known secrets in their encoded forms, and "name=value" pairs whose name says
 * they are secret. After the shared secret policy lands, callers should build `secrets` with runSecretValues (secret-policy.ts).
 */
import { loadEvidenceRuntime } from "./capture.js";

/** The forms of a run's secrets the masker looks for (once per session: building them is the costly part). */
export function observedTextSecrets(secrets: ReadonlyArray<string | undefined>): string[] {
    return loadEvidenceRuntime().evidenceSecrets(secrets.filter((s): s is string => typeof s === "string" && s.length >= 4));
}

/** One masked, single-line, capped observation. `forms` come from observedTextSecrets. */
export function maskObservedText(text: string, forms: readonly string[], max = 300): string {
    return loadEvidenceRuntime().evidenceText(text.replace(/\s+/g, " "), [...forms], max);
}
