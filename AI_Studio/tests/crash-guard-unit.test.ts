import { describe, expect, it } from "vitest";
import { isBrowserLibraryError } from "../src/platform/crash-guard.js";

const withStack = (stack: string) => Object.assign(new Error("x"), { stack });

describe("crash guard", () => {
    it("recognises errors that come from the browser library, on Windows and Unix paths", () => {
        const windows = String.raw`Error: Frame for this navigation request is not available
    at RouteHandler.handle (C:\app\node_modules\playwright-core\lib\coreBundle.js:60147:38)`;
        const unix = "Error: x\n    at foo (/srv/app/node_modules/playwright/lib/x.js:1:1)";
        expect(isBrowserLibraryError(withStack(windows))).toBe(true);
        expect(isBrowserLibraryError(withStack(unix))).toBe(true);
    });
    it("does not excuse the platform's own errors or non-errors", () => {
        const own = String.raw`Error: boom
    at run (C:\app\src\platform\job-runner.ts:10:5)`;
        expect(isBrowserLibraryError(withStack(own))).toBe(false);
        expect(isBrowserLibraryError("a string")).toBe(false);
        expect(isBrowserLibraryError(undefined)).toBe(false);
    });
});
