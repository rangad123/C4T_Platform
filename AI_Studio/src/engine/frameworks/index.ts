import { playwrightAdapter, playwrightApiAdapter, taqwrightAdapter } from "./builtin.js";
import { iosAdapter } from "./ios.js";
import { registerBuiltInAdapter } from "./registry.js";
import { windowsAdapter } from "./windows.js";

export * from "./types.js";
export * from "./registry.js";
export { LocalExecutor, localExecutor, executorFor, setExecutorResolver } from "./executor.js";
export { playwrightAdapter, playwrightApiAdapter, taqwrightAdapter } from "./builtin.js";
export { windowsAdapter, WindowsAdapter } from "./windows.js";
export { iosAdapter, IosAdapter } from "./ios.js";

// Registration order matters: it is the order of `listAdapters()` and the order batches of different runtimes run in
// (web first, then mobile), exactly as before adapters existed.
for (const a of [playwrightAdapter, playwrightApiAdapter, taqwrightAdapter, windowsAdapter, iosAdapter]) registerBuiltInAdapter(a);
