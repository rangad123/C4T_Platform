import type { TestKind, TestSpec } from "../spec/schema.js";

/** The frameworks that ship with the platform. */
export type BuiltInFramework = "playwright" | "playwright-api" | "taqwright" | "windows-uia";
/** A framework id as stored in databases. Open: a framework adapter registered at start-up adds its own (see ../frameworks). */
export type Framework = BuiltInFramework | (string & {});

export interface RenderContext {
    /** Origin the web tests run against, e.g. https://example.com */
    baseUrl: string;
    /** Base URL for API requests (defaults to baseUrl). */
    apiBaseUrl?: string;
    /** The project's test data sets by name; a spec that names one (`testData.dataSet`) is rendered once per row. */
    dataSets?: Record<string, import("../testdata/dataset.js").DataSet>;
    /** DELETE operations the API description knows (templates such as /things/{id}): what data-changing API tests may use to remove the records they create (see ../cleanup/helper.ts). */
    deleteOps?: string[];
    /** The project's object repository (shared locators). A spec whose steps refer to an element is resolved against it before rendering; see ../locators/refs.ts. */
    objects?: import("../locators/refs.js").ObjectIndex;
    /** The project's reusable steps. A `useBlock` step is replaced by the block's steps before rendering (see ../blocks/expand.ts); generators never see one. */
    blocks?: import("../blocks/model.js").BlockIndex;
    /** The project's notes for the AI: the overlays they name ("close the newsletter popup") are closed in web scripts, as consent banners are. */
    notes?: readonly import("../memory/notes.js").SiteNote[];
    /** Open bugs linked to tests (test id -> the bug's reference, e.g. "PROJ-12 https://..."): such a test renders as `test.fail()`, so it stays green while the bug is there. */
    knownBugs?: Record<string, string>;
}

export interface RenderedScript {
    framework: Framework;
    /** File name relative to the suite directory, e.g. WEB-001.spec.ts */
    filename: string;
    content: string;
    language: "typescript";
}

/**
 * Extension point: implement this and register it in ./index.ts to add a new target framework.
 * Generators must be pure (spec in, script out) so scripts can be re-rendered at any time.
 */
export interface ScriptGenerator {
    readonly framework: Framework;
    readonly kind: TestKind;
    /** Whether this framework's output can be executed by the platform's validator. */
    readonly executable: boolean;
    render(spec: TestSpec, ctx: RenderContext): RenderedScript;
}
