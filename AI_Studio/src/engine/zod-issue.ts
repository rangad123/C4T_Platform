/**
 * Small readers of zod issues for the code that turns them into plain words. zod 4 leaves the received value off its issues, so a
 * missing value is told apart from a wrong one by the default message ("... received undefined").
 */
export interface IssueLike {
    code: string;
    message: string;
}

/** The issue says a required value is missing (not that it has the wrong type). */
export function isMissingValue(issue: IssueLike): boolean {
    return issue.code === "invalid_type" && (/received undefined$/.test(issue.message) || issue.message === "Required");
}

/** The value is not one of the allowed choices (an enum or a literal). */
export function isUnknownChoice(issue: IssueLike): boolean {
    return issue.code === "invalid_value";
}

/** A discriminated union found no option for the value's discriminator (a step's `action`, for example). */
export function isUnknownKind(issue: IssueLike & { note?: string }): boolean {
    return issue.code === "invalid_union" && issue.note === "No matching discriminator";
}
