/**
 * Something outside the workbench's own editors changed a test (it was switched to code, say). The page that shows the test asks the
 * platform again and rebuilds what it showed, so nothing on screen describes the test as it was.
 */
export const TEST_CHANGED = "aitp-test-changed";

export const announceTestChanged = (testId: string): void => {
    window.dispatchEvent(new CustomEvent<string>(TEST_CHANGED, { detail: testId }));
};
