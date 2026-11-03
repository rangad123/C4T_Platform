/** Shapes of the reusable libraries API (src/platform/routes/libraries.ts) and the words the pages share. */
export type ItemKind = "steps" | "helper" | "element";
export const KIND_LABEL: Record<ItemKind, string> = { steps: "Reusable steps", helper: "Helper (code)", element: "Shared element" };

export interface LibraryFolder {
    id: string;
    organizationId: string | null;
    parentId: string | null;
    name: string;
}
export interface LibraryItem {
    id: string;
    organizationId: string | null;
    folderId: string | null;
    kind: ItemKind;
    name: string;
    description: string;
    version: number;
    updatedAt: string;
}
export interface LibraryAnswer {
    organizations: Array<{ id: string | null; name: string; canChange: boolean }>;
    organization: { id: string | null; name: string } | null;
    canChange: boolean;
    folders: LibraryFolder[];
    items: Array<LibraryItem & { usedBy: number }>;
}
export interface ItemDetail {
    item: LibraryItem;
    content: any;
    stepsText?: string[];
    versions: Array<{ version: number; note: string; createdBy: string | null; createdAt: string; fromProject: { id: string | null; name: string | null } | null }>;
    usedBy: { projects: Array<{ projectId: string; projectName: string; version: number; localName: string; updateAvailable: boolean }>; otherProjects: number };
    canChange: boolean;
}
export interface ProjectLibrary {
    organization: { id: string | null; name: string };
    canPublish: boolean;
    folders: LibraryFolder[];
    items: Array<LibraryItem & { use: { version: number; localName: string; inProject: boolean; updateAvailable: boolean; changedHere: boolean } | null; nameTakenHere: boolean }>;
    local: Record<ItemKind, Array<{ name: string; itemId: string | null }>>;
}

/** The organisation in a link: `internal` for the library of projects without an organisation. */
export const orgParam = (id: string | null): string => id ?? "internal";

/** "Checkout / Payments" for a folder, from its parents. */
export function folderPath(folders: LibraryFolder[], id: string | null): string {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const names: string[] = [];
    for (let f = id ? byId.get(id) : undefined, n = 0; f && n < 10; f = f.parentId ? byId.get(f.parentId) : undefined, n++) names.unshift(f.name);
    return names.join(" / ");
}

/** Folders in tree order with their depth (0 = top level), for lists and pickers. */
export function folderTree(folders: LibraryFolder[]): Array<LibraryFolder & { depth: number }> {
    const out: Array<LibraryFolder & { depth: number }> = [];
    const walk = (parent: string | null, depth: number) => {
        for (const f of folders.filter((x) => x.parentId === parent).sort((a, b) => a.name.localeCompare(b.name))) {
            out.push({ ...f, depth });
            if (depth < 10) walk(f.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
