/**
 * Frames, test files and popups: the small shared pieces the generator, the live interpreter, the recorder and the platform use, so
 * they agree on how a frame is found, where a test file is placed and how a popup is followed. See docs/features/frames-uploads-popups.md.
 */
import { TEST_FILE_NAME, type FrameRef, type Step, type TestSpec } from "../spec/schema.js";

/** CSS string contents for an attribute selector (the schema already refuses line breaks in a frame's name). */
const cssString = (v: string): string => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** The CSS selector that finds a frame element on its parent page: by name (iframe or old-style frame), by title, or by a part of its address. */
export function frameSelector(f: FrameRef): string {
    const v = cssString(f.value);
    switch (f.by) {
        case "name":
            return `iframe[name="${v}"], frame[name="${v}"]`;
        case "title":
            return `iframe[title="${v}"], frame[title="${v}"]`;
        case "url":
            return `iframe[src*="${v}"], frame[src*="${v}"]`;
    }
}

/**
 * How a frame the recorder or explorer saw is written down: its name when it has a meaningful one, else its title, else the stable part of
 * its address (host and path, no query: tokens in the query change every load). Undefined when nothing identifies it (it is then not followed).
 */
export function describeFrame(f: { name?: string | null; title?: string | null; /** The frame element's own `src` attribute (what `src*=` will be matched against). */ src?: string | null }): FrameRef | undefined {
    const name = (f.name ?? "").trim();
    // Generated names ("__privateStripeFrame1234", random hex) change between loads; they are not worth keeping.
    if (name && name.length <= 80 && !/\d{3,}|^[0-9a-f-]{16,}$/i.test(name) && !/[\u0000-\u001f]/.test(name)) return { by: "name", value: name };
    const title = (f.title ?? "").replace(/\s+/g, " ").trim();
    if (title && title.length <= 120) return { by: "title", value: title };
    // The address part is taken from the attribute as written (a relative src stays relative), so `src*=` finds the same frame again.
    const src = (f.src ?? "").trim();
    if (!src || /^(about|data|javascript|blob):/i.test(src)) return undefined; // srcdoc and friends cannot be found again by address
    try {
        const absolute = /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//");
        const u = new URL(src, "http://relative.invalid");
        const v = (absolute ? `${u.host}${u.pathname}` : u.pathname).slice(0, 200);
        if (v && v !== "/") return { by: "url", value: v };
    } catch {
        /* an address that cannot be read cannot be found again */
    }
    return undefined;
}

// ── test files ──────────────────────────────────────────────────────────

/**
 * Test files reach a run the way approved screenshots do: the platform places each one in the run's `__baselines__` folder (which runner
 * agents already download, checked by hash) under this prefix, so it can never be mistaken for a screenshot and needs no new protocol field.
 */
export const TEST_FILE_PREFIX = "upload--";
export const testFileSlot = (name: string): string => `${TEST_FILE_PREFIX}${name}`;
export const isTestFileName = (name: string): boolean => TEST_FILE_NAME.test(name) && !name.includes("..");

/** The test files a test's steps upload (after reusable steps are put in place), each once. */
export function uploadFilesOf(spec: Pick<TestSpec, "steps">): string[] {
    const out = new Set<string>();
    for (const s of spec.steps as Step[]) if (s.action === "upload") out.add(s.file);
    return [...out];
}

/** A name a person gave a file, made into one steps can use ("My photo (1).PNG" → "My-photo-1.PNG"), or undefined when nothing usable is left. */
export function testFileNameFrom(raw: string): string | undefined {
    const base = raw.replace(/\\/g, "/").split("/").pop() ?? "";
    const cleaned = base
        .replace(/\s+/g, "-")
        .replace(/[^A-Za-z0-9._-]/g, "")
        .replace(/\.{2,}/g, ".")
        .replace(/^[^A-Za-z0-9]+/, "")
        .slice(0, 100);
    return cleaned && isTestFileName(cleaned) ? cleaned : undefined;
}

/** Script helpers for upload steps: the file is looked up next to the script; a field that is not a file input is clicked and the file chooser answered. */
export const UPLOAD_HELPER_SOURCE = String.raw`/** Test files come from the project's library: the platform places each one next to this script before it runs. */
function testFile(name: string): string {
    const placed = testFileJoin(test.info().project.testDir, "__baselines__", "${TEST_FILE_PREFIX}" + name);
    if (!testFileExists(placed)) throw new Error("The test file \"" + name + "\" is not available to this run. Add it under Settings, Test data, Test files, or check its name.");
    // The page sees the file under its own name (not the name it travels under).
    const dir = testFileJoin(test.info().outputDir, "test-files");
    testFileMkdir(dir, { recursive: true });
    const file = testFileJoin(dir, name);
    testFileCopy(placed, file);
    return file;
}

/** Uploads a test file into a file field, or through the file chooser a button opens. */
async function uploadTestFile(page: import("@playwright/test").Page, target: import("@playwright/test").Locator, name: string): Promise<void> {
    const file = testFile(name);
    const isFileInput = await target.evaluate((el) => el instanceof HTMLInputElement && el.type === "file").catch(() => false);
    if (isFileInput) return target.setInputFiles(file);
    const chooser = page.waitForEvent("filechooser");
    await target.click();
    await (await chooser).setFiles(file);
}
`;

export const UPLOAD_IMPORTS = 'import { copyFileSync as testFileCopy, existsSync as testFileExists, mkdirSync as testFileMkdir } from "node:fs";\nimport { join as testFileJoin } from "node:path";\n';

/** Declared at the top of a test that follows popups: the popup an earlier step opened, and the way a step reaches it. */
export const POPUP_SETUP = `    let popup: typeof page | undefined;
    const popupPage = () => {
        if (!popup || popup.isClosed()) throw new Error("No popup window is open. A step before this one must open it (Click ... and wait for the popup).");
        return popup;
    };
`;

export const usesPopups = (spec: Pick<TestSpec, "steps">): boolean => spec.steps.some((s) => ("inPopup" in s && s.inPopup === true) || (s.action === "click" && s.opensPopup === true));

/** Steps "in the popup" with no earlier click that opens one, and checks that only work on the starting page (empty = fine). */
export function popupProblems(steps: readonly Step[]): Array<{ stepIndex: number; message: string }> {
    const out: Array<{ stepIndex: number; message: string }> = [];
    let opened = false;
    steps.forEach((s, i) => {
        if ("inPopup" in s && s.inPopup === true) {
            if (!opened) out.push({ stepIndex: i, message: "this step works in the popup, but no step before it opens one. Set “Opens a popup” on the click that opens it." });
            else if (s.action === "assert" && MAIN_PAGE_ONLY_CHECKS.has(s.check)) out.push({ stepIndex: i, message: "this check works on the page the test started on, not in a popup." });
        }
        if (s.action === "click" && s.opensPopup === true) opened = true;
    });
    return out;
}

/** Checks that only make sense for the page the test started on (their collectors and budgets are set up there). */
export const MAIN_PAGE_ONLY_CHECKS = new Set(["noConsoleErrors", "noFailedRequests", "noBrokenLinks", "noMixedContent", "pageBasics", "pageSpeed", "inputHandling", "accessDenied", "looksRight", "screenshot", "a11y"]);
