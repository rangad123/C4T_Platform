/**
 * Typing any text (accents, other scripts, emoji) on a phone, safely.
 *
 * `adb shell input text` can only type printable ASCII, so the device session refuses anything else. When the phone's CURRENT keyboard is ADBKeyboard
 * (an open-source keyboard app, installed and selected by the owner; see docs/features/phone-reliability.md), text can instead be sent to it as one
 * broadcast whose only argument is the base64 of the UTF-8 text: letters, digits, + / and =, nothing any shell reads. The platform never installs the
 * keyboard and never switches the phone's keyboard (that would change a setting); it only looks at which keyboard is selected.
 */

/** The input method id ADBKeyboard registers. */
export const ADB_KEYBOARD_ID = "com.android.adbkeyboard/.AdbIME";
/** Longest text typed in one broadcast (characters). */
export const MAX_UNICODE_TEXT = 1000;

/** Is ADBKeyboard the keyboard the phone uses right now? Read from `dumpsys input_method` (mCurMethodId, or the selected method on older versions). */
export function adbKeyboardSelected(inputMethodDump: string): boolean {
    const m = /\bmCurMethodId=(\S+)/.exec(inputMethodDump) ?? /\bmSelectedMethodId=(\S+)/.exec(inputMethodDump);
    return m?.[1] === ADB_KEYBOARD_ID;
}

/** Text the keyboard can take: no control characters or line breaks (one field, one line), not empty, not too long. Undefined = fine. */
export function unicodeProblem(text: string): string | undefined {
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)) return "Text with line breaks can't be typed. Type one line at a time.";
    if (!text.length) return "There is no text to type.";
    if (text.length > MAX_UNICODE_TEXT) return `Text to type can be at most ${MAX_UNICODE_TEXT} characters.`;
    return undefined;
}

/** The broadcast's argument: base64 of the UTF-8 bytes. */
export function encodeForAdbKeyboard(text: string): string {
    return Buffer.from(text, "utf8").toString("base64");
}

/** True when the text needs the keyboard (anything outside printable ASCII). */
export function needsUnicodeKeyboard(text: string): boolean {
    return /[^\x20-\x7e]/.test(text);
}
