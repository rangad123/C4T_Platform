/** Calls the workbench makes that are not part of one editor: take the steps back to an earlier version. */
import { bapi, type SaveAnswer, type SpecAnswer } from "../builder/builder";
import type { Snapshot } from "../builder/stepdiff";

export interface SpecVersionBody {
    version: number;
    spec: Snapshot & { [k: string]: unknown };
    note: string | null;
    createdAt: string;
}

/**
 * Saves an earlier version of the steps again as the newest one (nothing is deleted), the way the step editor's history always did.
 * With `run: false` the test is saved and not run.
 */
export async function restoreSpecVersion(testId: string, version: number, o: { run: boolean; note?: string }): Promise<SaveAnswer> {
    const [body, current] = await Promise.all([bapi<SpecVersionBody>(`/tests/${testId}/spec-versions/${version}`), bapi<SpecAnswer>(`/tests/${testId}/spec`)]);
    // The old version is the whole test as it was (the platform still takes the id, kind, area and origin from the stored test).
    const spec = { ...current.spec, ...body.spec, title: body.spec.title, testData: body.spec.testData ?? {}, steps: body.spec.steps } as SpecAnswer["spec"];
    return bapi<SaveAnswer>(`/tests/${testId}/spec`, { method: "PUT", body: { spec, note: o.note ?? `Restored version ${version}`, ...(o.run ? {} : { run: false }) } });
}
