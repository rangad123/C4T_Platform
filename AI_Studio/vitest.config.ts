import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/**/*.test.ts"],
        testTimeout: 120_000,
        hookTimeout: 30_000,
        fileParallelism: false,
        // Every file outside the fast tier waits for the "browser" lock, and no file starts a browser without it.
        setupFiles: ["tests/browser-lock.setup.ts"],
    },
});
