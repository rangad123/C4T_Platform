import { expandBlocks } from "../blocks/expand.js";
import { resolveSpecRefs } from "../locators/refs.js";
import type { TestSpec } from "../spec/schema.js";
import { apiGenerator } from "./api.js";
import { iosGenerator } from "./ios.js";
import { playwrightGenerator } from "./playwright.js";
import { taqwrightGenerator } from "./taqwright.js";
import { windowsGenerator } from "./windows.js";
import type { Framework, RenderContext, RenderedScript, ScriptGenerator } from "./types.js";

export type { Framework, RenderContext, RenderedScript, ScriptGenerator } from "./types.js";

const registry = new Map<Framework, ScriptGenerator>();

/** Register a generator. Add new frameworks here (see docs: "Adding another testing framework"). */
export function registerGenerator(g: ScriptGenerator): void {
    registry.set(g.framework, g);
}

[playwrightGenerator, apiGenerator, taqwrightGenerator, windowsGenerator, iosGenerator].forEach(registerGenerator);

export function getGenerator(framework: Framework): ScriptGenerator {
    const g = registry.get(framework);
    if (!g) throw new Error(`No script generator registered for framework "${framework}"`);
    return g;
}

export function listGenerators(): ScriptGenerator[] {
    return [...registry.values()];
}

/** The default (executable) framework for a spec kind. */
export function defaultFramework(kind: TestSpec["kind"]): Framework {
    return kind === "web" ? "playwright" : kind === "api" ? "playwright-api" : kind === "desktop" ? "windows-uia" : "taqwright";
}

export function renderScript(spec: TestSpec, framework: Framework, ctx: RenderContext): RenderedScript {
    const g = getGenerator(framework);
    if (spec.kind !== g.kind && !(g.kind === "mobile" && spec.kind === "web")) {
        throw new Error(`Framework "${framework}" cannot render a "${spec.kind}" spec`);
    }
    return g.render(resolveSpecRefs(expandBlocks(spec, ctx.blocks), ctx.objects), ctx);
}
