/**
 * A permission code (features/auth/permissions.ts `Permission`). Kept as text here so these rules load without the page's modules
 * (the server's tests import them).
 */
type Permission = string;

/**
 * What the signed-in person may do in one project: the `access.permissions` the server sends with `GET /api/projects/:id` (the codes
 * that count there, after the project's role). The page uses them to hide or switch off what the server would refuse; the server
 * still checks every request, so a guess here never widens anything.
 *
 * `undefined` means "not known" (still loading, the read failed, or an older server that does not say): then nothing is assumed and
 * every control stays as it was.
 */
export type HerePermissions = readonly string[] | undefined;

/** Open mode and access-key sessions hold every permission (the server sends them all): while the project has not answered, nothing is switched off for them. */
export function fullAccess(kind: string | undefined): boolean {
    return kind === "open" || kind === "key";
}

/** The one-line reasons a control is switched off, by the permission it needs. */
export const NO_PERMISSION_HERE: Readonly<Record<string, string>> = {
    "ai_studio.tests.write": "Changing this needs permission to write tests in this project. Ask a Project Admin.",
    "ai_studio.tests.delete": "Deleting needs permission to delete in this project. Ask a Project Admin.",
    "ai_studio.tests.generate": "This uses the AI and needs permission to generate tests in this project. Ask a Project Admin.",
    "ai_studio.tests.run": "Running tests needs permission to run tests in this project. Ask a Project Admin.",
    "ai_studio.project.settings": "Changing this needs permission to change project settings. Ask a Project Admin.",
    "ai_studio.project.members": "Changing members needs permission to manage project members. Ask a Project Admin.",
    "ai_studio.ai_keys.manage": "Changing this needs permission to manage connections and keys. Ask a Project Admin.",
    "ai_studio.reports.export": "Downloading needs permission to download reports in this project. Ask a Project Admin.",
};
export const whyNot = (p: Permission): string => NO_PERMISSION_HERE[p] ?? "You do not have permission to do this in this project. Ask a Project Admin.";

export interface Here {
    /** The person may do what needs `p` in this project. */
    may: (p: Permission) => boolean;
    /** The sentence to show on a switched-off control that needs `p`, or undefined when they may. */
    why: (p: Permission) => string | undefined;
    /** The project's list is known (it answered with `access`). */
    known: boolean;
}

/**
 * `permissions`: the project's list, or undefined when not known. `platform`: the person's platform-wide permissions (`can()`), used
 * while the project's list is not known, so a failed read leaves every control as it was before projects had their own list.
 */
export function hereOf(permissions: HerePermissions, full: boolean, platform: (p: Permission) => boolean = () => true): Here {
    // The server's list for this project wins when it is known (in open mode and for an access key it holds every permission).
    // Only while it is not known does a full-access session assume everything, and anyone else their platform-wide permissions.
    const list = permissions;
    const may = (p: Permission) => (list !== undefined ? list.includes(p) : full || platform(p));
    return { may, why: (p) => (may(p) ? undefined : whyNot(p)), known: list !== undefined };
}
