/**
 * Thrown by a device session when the PHONE or the link to it fails (device gone, adb dead, the runner agent stopped answering, the session ended or hit its
 * cap). It is never a verdict about the app under test: the explorer ends the exploration with this message and does not report a failing test.
 * A refused or failed action (a stale element, a field that cannot be typed into) is NOT thrown: it comes back as `{ ok: false, error }`.
 */
export class DeviceSessionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DeviceSessionError";
    }
}
