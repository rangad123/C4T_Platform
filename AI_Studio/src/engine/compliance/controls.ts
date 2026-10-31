/**
 * Compliance control library.
 *
 * Ported from ai-testing-agent's `compliance.py` CONTROL_LIBRARY (MIT, Copyright (c) 2026 dannicolau7,
 * https://github.com/dannicolau7/ai-testing-agent): the same controls, titles, descriptions, keyword lists
 * and HTTP-method filters for NIST SP 800-53, HIPAA Technical Safeguards (45 CFR §164.312) and
 * ISO/IEC 27001. Generated from the upstream file, not retyped.
 *
 * This is an *indicative* mapping that helps organise test evidence; it is not a compliance assessment.
 */

export const FRAMEWORKS = ["NIST-800-53", "HIPAA", "ISO-27001"] as const;
export type Framework = (typeof FRAMEWORKS)[number];

export interface Control {
    id: string;
    framework: Framework;
    title: string;
    description: string;
    /** Words that, appearing in a test's paths, make the control relevant. */
    pathKeywords: string[];
    /** Words in a test's title / area / tags that make the control relevant. */
    tagKeywords: string[];
    /** If set, the control applies only to tests that use one of these HTTP methods. */
    methods: string[];
}

export const CONTROLS: Control[] = [
    {
        "id": "NIST-AC-2",
        "framework": "NIST-800-53",
        "title": "Account Management",
        "description": "Manage system accounts and enforce lifecycle policies.",
        "pathKeywords": [
            "user",
            "account",
            "member",
            "register",
            "signup",
            "profile"
        ],
        "tagKeywords": [
            "user",
            "account",
            "member"
        ],
        "methods": []
    },
    {
        "id": "NIST-AC-3",
        "framework": "NIST-800-53",
        "title": "Access Enforcement",
        "description": "Enforce approved authorizations for access to resources.",
        "pathKeywords": [
            "admin",
            "role",
            "permission",
            "privilege",
            "access",
            "grant",
            "revoke"
        ],
        "tagKeywords": [
            "admin",
            "role",
            "authorization"
        ],
        "methods": []
    },
    {
        "id": "NIST-AC-6",
        "framework": "NIST-800-53",
        "title": "Least Privilege",
        "description": "Employ least privilege, allowing only authorized access.",
        "pathKeywords": [
            "admin",
            "role",
            "scope",
            "permission"
        ],
        "tagKeywords": [
            "admin",
            "role"
        ],
        "methods": [
            "GET",
            "PUT",
            "PATCH",
            "DELETE"
        ]
    },
    {
        "id": "NIST-AC-17",
        "framework": "NIST-800-53",
        "title": "Remote Access",
        "description": "Establish and document restrictions for remote access.",
        "pathKeywords": [
            "api",
            "v1",
            "v2",
            "v3",
            "external",
            "remote"
        ],
        "tagKeywords": [
            "api",
            "external"
        ],
        "methods": []
    },
    {
        "id": "NIST-IA-2",
        "framework": "NIST-800-53",
        "title": "Identification and Authentication",
        "description": "Uniquely identify and authenticate organizational users.",
        "pathKeywords": [
            "login",
            "auth",
            "signin",
            "authenticate",
            "token",
            "jwt",
            "oauth",
            "sso",
            "session",
            "whoami",
            "me"
        ],
        "tagKeywords": [
            "auth",
            "authentication",
            "identity"
        ],
        "methods": []
    },
    {
        "id": "NIST-IA-5",
        "framework": "NIST-800-53",
        "title": "Authenticator Management",
        "description": "Manage authenticators including passwords and tokens.",
        "pathKeywords": [
            "password",
            "credential",
            "reset",
            "secret",
            "key",
            "apikey",
            "api-key",
            "token",
            "refresh"
        ],
        "tagKeywords": [
            "auth",
            "credential",
            "password"
        ],
        "methods": []
    },
    {
        "id": "NIST-AU-2",
        "framework": "NIST-800-53",
        "title": "Audit Events",
        "description": "Identify the types of events the system can audit.",
        "pathKeywords": [
            "audit",
            "log",
            "event",
            "history",
            "activity",
            "track"
        ],
        "tagKeywords": [
            "audit",
            "log",
            "event"
        ],
        "methods": []
    },
    {
        "id": "NIST-AU-3",
        "framework": "NIST-800-53",
        "title": "Audit Record Content",
        "description": "Audit records capture sufficient detail for post-incident analysis.",
        "pathKeywords": [
            "audit",
            "log",
            "report",
            "trail"
        ],
        "tagKeywords": [
            "audit",
            "log"
        ],
        "methods": []
    },
    {
        "id": "NIST-SI-10",
        "framework": "NIST-800-53",
        "title": "Information Input Validation",
        "description": "Check inputs for accuracy, completeness, and validity.",
        "pathKeywords": [],
        "tagKeywords": [],
        "methods": [
            "POST",
            "PUT",
            "PATCH"
        ]
    },
    {
        "id": "NIST-SC-8",
        "framework": "NIST-800-53",
        "title": "Transmission Confidentiality and Integrity",
        "description": "Implement cryptographic protections for transmitted information.",
        "pathKeywords": [],
        "tagKeywords": [],
        "methods": []
    },
    {
        "id": "HIPAA-164.312.a.1",
        "framework": "HIPAA",
        "title": "Access Control",
        "description": "Allow access only to authorized persons or software programs.",
        "pathKeywords": [
            "user",
            "account",
            "admin",
            "role",
            "permission",
            "access"
        ],
        "tagKeywords": [
            "user",
            "account",
            "admin"
        ],
        "methods": []
    },
    {
        "id": "HIPAA-164.312.a.2.i",
        "framework": "HIPAA",
        "title": "Unique User Identification",
        "description": "Assign a unique name/number to each user for tracking access.",
        "pathKeywords": [
            "user",
            "account",
            "register",
            "signup",
            "id",
            "profile"
        ],
        "tagKeywords": [
            "user",
            "identity"
        ],
        "methods": []
    },
    {
        "id": "HIPAA-164.312.b",
        "framework": "HIPAA",
        "title": "Audit Controls",
        "description": "Record and examine activity in systems containing ePHI.",
        "pathKeywords": [
            "audit",
            "log",
            "event",
            "history",
            "track",
            "activity"
        ],
        "tagKeywords": [
            "audit",
            "log"
        ],
        "methods": []
    },
    {
        "id": "HIPAA-164.312.d",
        "framework": "HIPAA",
        "title": "Person or Entity Authentication",
        "description": "Verify that a person or entity seeking access is who claimed.",
        "pathKeywords": [
            "login",
            "auth",
            "authenticate",
            "token",
            "session",
            "oauth",
            "mfa",
            "2fa",
            "verify"
        ],
        "tagKeywords": [
            "auth",
            "authentication"
        ],
        "methods": []
    },
    {
        "id": "HIPAA-164.312.e.1",
        "framework": "HIPAA",
        "title": "Transmission Security",
        "description": "Guard against unauthorized access to ePHI during transmission.",
        "pathKeywords": [
            "patient",
            "health",
            "phi",
            "ehr",
            "medical",
            "diagnosis",
            "prescription",
            "record",
            "clinical"
        ],
        "tagKeywords": [
            "patient",
            "health",
            "phi",
            "medical"
        ],
        "methods": []
    },
    {
        "id": "ISO-A.9.2.1",
        "framework": "ISO-27001",
        "title": "User Registration and De-registration",
        "description": "Implement a formal user registration and de-registration process.",
        "pathKeywords": [
            "user",
            "register",
            "signup",
            "deactivate",
            "delete",
            "account"
        ],
        "tagKeywords": [
            "user",
            "account"
        ],
        "methods": [
            "POST",
            "DELETE"
        ]
    },
    {
        "id": "ISO-A.9.4.2",
        "framework": "ISO-27001",
        "title": "Secure Log-on Procedures",
        "description": "Control access using a secure log-on procedure.",
        "pathKeywords": [
            "login",
            "auth",
            "signin",
            "session",
            "oauth",
            "token"
        ],
        "tagKeywords": [
            "auth",
            "login"
        ],
        "methods": []
    },
    {
        "id": "ISO-A.9.4.3",
        "framework": "ISO-27001",
        "title": "Password Management System",
        "description": "Ensure quality passwords via an interactive management system.",
        "pathKeywords": [
            "password",
            "credential",
            "reset",
            "change-password",
            "secret"
        ],
        "tagKeywords": [
            "password",
            "credential"
        ],
        "methods": []
    },
    {
        "id": "ISO-A.12.4.1",
        "framework": "ISO-27001",
        "title": "Event Logging",
        "description": "Produce, protect, and retain event logs recording user activities.",
        "pathKeywords": [
            "log",
            "audit",
            "event",
            "activity",
            "history",
            "trail"
        ],
        "tagKeywords": [
            "log",
            "audit",
            "event"
        ],
        "methods": []
    },
    {
        "id": "ISO-A.14.1.2",
        "framework": "ISO-27001",
        "title": "Securing Application Services",
        "description": "Protect information transacting over public networks.",
        "pathKeywords": [
            "payment",
            "checkout",
            "order",
            "transaction",
            "billing",
            "invoice"
        ],
        "tagKeywords": [
            "payment",
            "billing",
            "order"
        ],
        "methods": []
    },
    {
        "id": "ISO-A.14.2.8",
        "framework": "ISO-27001",
        "title": "System Security Testing",
        "description": "Test security functionality during development.",
        "pathKeywords": [],
        "tagKeywords": [],
        "methods": []
    }
];
