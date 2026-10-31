import type { GuideStep } from "../types.js";

/** A step with the on-screen names it mentions (`ui`), written verbatim so a test can check they exist in the web code. */
export const step = (text: string, ...ui: string[]): GuideStep => (ui.length ? { text, ui } : { text });
