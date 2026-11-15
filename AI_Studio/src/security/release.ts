/**
 * When the release that makes legacy client authorizations expire was deployed (ISO, UTC). Shipped with the code, so a database restored
 * from an older backup cannot move it: a legacy authorization (recorded without the authorizing person's role and authority) stops
 * counting LEGACY_AUTHORIZATION_VALID_DAYS after this moment (authorization.ts), whenever the database was first opened.
 *
 * Set it at release time to the deployment day (or earlier: earlier is stricter, never later). The release check
 * (tests/security-profile-gate-expiry-legacy.test.ts) fails if it is unset, unreadable, in the future or before the rule was built.
 */
export const LEGACY_AUTHORIZATION_RELEASE_AT = "2026-11-15T00:00:00.000Z";
