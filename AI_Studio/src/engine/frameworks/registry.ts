import { expandBlocks } from "../blocks/expand.js";
import { resolveSpecRefs } from "../locators/refs.js";
import type { TestKind, TestSpec } from "../spec/schema.js";
import type { FrameworkAdapter, GeneratedScript, RenderContext } from "./types.js";

/** A stored or requested framework id that no adapter handles. Plain message: it can reach a person. */
export class UnknownFrameworkError extends Error {
    constructor(
        readonly framework: string,
        available: readonly string[],
    ) {
        super(`The testing framework "${framework}" is not available in this platform (available: ${available.join(", ") || "none"}).`);
        this.name = "UnknownFrameworkError";
    }
}

export class DuplicateFrameworkError extends Error {
    constructor(readonly framework: string) {
        super(`A testing framework with the id "${framework}" is already registered.`);
        this.name = "DuplicateFrameworkError";
    }
}

/** Holds adapters in registration order. Exported as a class so tests can use a private one; the platform uses the shared one below. */
export class AdapterRegistry {
    private readonly adapters = new Map<string, FrameworkAdapter>();

    /** Add an adapter. A second adapter with the same id is refused (ids are stored in databases). */
    register(adapter: FrameworkAdapter): void {
        if (!adapter.id.trim()) throw new Error("A framework adapter needs an id.");
        if (this.adapters.has(adapter.id)) throw new DuplicateFrameworkError(adapter.id);
        this.adapters.set(adapter.id, adapter);
    }

    unregister(id: string): boolean {
        return this.adapters.delete(id);
    }

    has(id: string): boolean {
        return this.adapters.has(id);
    }

    get(id: string): FrameworkAdapter {
        const a = this.adapters.get(id);
        if (!a) throw new UnknownFrameworkError(id, [...this.adapters.keys()]);
        return a;
    }

    list(): FrameworkAdapter[] {
        return [...this.adapters.values()];
    }
}

/** The platform's registry. Built-in adapters are added when `./index.ts` loads. */
export const adapters = new AdapterRegistry();
const builtInIds = new Set<string>();

export function registerAdapter(adapter: FrameworkAdapter): void {
    adapters.register(adapter);
}

/** Registers a shipped adapter; those cannot be removed. */
export function registerBuiltInAdapter(adapter: FrameworkAdapter): void {
    adapters.register(adapter);
    builtInIds.add(adapter.id);
}

/** Remove an adapter added with `registerAdapter` (tests, plug-ins). Built-in adapters stay. Returns whether one was removed. */
export function unregisterAdapter(id: string): boolean {
    return builtInIds.has(id) ? false : adapters.unregister(id);
}

/** True for the frameworks that ship with the platform (an adapter plug-in may never take one of these ids). */
export const isBuiltInAdapterId = (id: string): boolean => builtInIds.has(id);

export const hasAdapter = (id: string): boolean => adapters.has(id);
export const getAdapter = (id: string): FrameworkAdapter => adapters.get(id);
export const listAdapters = (): FrameworkAdapter[] => adapters.list();

/** Render a spec with the adapter that owns `framework`. Byte-identical to the old direct generator call for the built-ins. */
export function renderWithAdapter(spec: TestSpec, framework: string, ctx: RenderContext): GeneratedScript {
    // Shared-element references become the element's locator here; a script never contains one (see ../locators/refs.ts).
    // Reusable steps are put in place first (their steps may refer to shared elements); an adapter never sees a `useBlock` step.
    return getAdapter(framework).render(resolveSpecRefs(expandBlocks(spec, ctx.blocks), ctx.objects), ctx);
}

/** The adapter the platform uses for a test kind when nothing else is chosen (the first registered adapter that lists the kind). */
export function defaultAdapterFor(kind: TestKind): FrameworkAdapter {
    const a = adapters.list().find((x) => x.kinds.includes(kind));
    if (!a) throw new UnknownFrameworkError(`(default for ${kind} tests)`, adapters.list().map((x) => x.id));
    return a;
}

/**
 * The adapter for a spec: the default one for its kind, except that a mobile spec with `platform: "ios"` belongs to the iOS adapter.
 * Use this wherever a spec is at hand; `defaultAdapterFor(kind)` cannot tell an iOS test from an Android one.
 */
export function adapterForSpec(spec: Pick<TestSpec, "kind"> & { platform?: string }): FrameworkAdapter {
    if (spec.kind === "mobile" && spec.platform === "ios") {
        const ios = adapters.list().find((x) => x.id === IOS_ADAPTER_ID);
        if (ios) return ios;
    }
    return defaultAdapterFor(spec.kind);
}

/** The stored id of the iOS adapter. */
export const IOS_ADAPTER_ID = "taqwright-ios";

/** True when running this framework needs a device (an Android emulator today, later iOS): it cannot run without the project's app target. */
export function needsDevice(adapter: FrameworkAdapter): boolean {
    return Boolean(adapter.needs.android || adapter.needs.ios);
}

/**
 * Split items into batches by the runtime of their framework. Adapters that share a runtime (Playwright web and API) land in one
 * batch; batches come in adapter registration order, which keeps "web first, then mobile". `adapter` is the first registered
 * adapter present in the batch and is the one the batch is sent to.
 */
export function groupByRuntime<T>(items: readonly T[], frameworkOf: (item: T) => string): Array<{ adapter: FrameworkAdapter; entries: Array<{ item: T; index: number }> }> {
    const entries = items.map((item, index) => ({ item, index, adapter: getAdapter(frameworkOf(item)) }));
    const present = new Set(entries.map((e) => e.adapter.id));
    const seen = new Set<string>();
    const groups: Array<{ adapter: FrameworkAdapter; entries: Array<{ item: T; index: number }> }> = [];
    for (const adapter of adapters.list()) {
        if (!present.has(adapter.id) || seen.has(adapter.runtime)) continue;
        seen.add(adapter.runtime);
        groups.push({ adapter, entries: entries.filter((e) => e.adapter.runtime === adapter.runtime).map(({ item, index }) => ({ item, index })) });
    }
    return groups;
}
