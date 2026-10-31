/** An error that maps to an HTTP status and a client-facing message. */
export class HttpError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly details?: unknown,
    ) {
        super(message);
    }
}
