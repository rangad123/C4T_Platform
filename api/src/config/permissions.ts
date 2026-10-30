/**
 * §2.2 "Sub-Admin Permissions" — the catalogue of capabilities an Admin can
 * delegate to a Sub-Admin.
 *
 * ADMIN implicitly holds every permission and is never checked against this
 * table. SUB_ADMIN holds only what has been explicitly granted.
 * CUSTOMER and TESTER are not permission-driven inside this API: their access
 * is scoped by ownership (own organisation, own assignments), enforced in the
 * services. They may hold AI Studio codes, which this API never checks — AI
 * Studio reads them from `/v1/auth/me` (see `modules/users/permission-rules.ts`).
 *
 * Codes are a stable contract — grant rows reference them. Add freely, never
 * rename. If a code must change, migrate the grants in the same release.
 */

export const PERMISSION_GROUPS = {
  PROJECTS: 'Projects',
  ORGANISATIONS: 'Organisations',
  TESTERS: 'Testers',
  MANAGERS: 'Managers',
  BUGS: 'Bugs',
  COMMUNICATION: 'Communication',
  RATINGS: 'Ratings & Reviews',
  TRANSACTIONS: 'Transactions',
  USERS: 'Users & Access',
  PLATFORM: 'Platform',
  BLOG: 'Blog',
  AI_STUDIO: 'AI Studio',
} as const

export interface PermissionDefinition {
  code: string
  group: string
  label: string
  description: string
}

export const PERMISSIONS = {
  // Projects — §2.2 Project Management
  PROJECT_READ: 'project.read',
  PROJECT_WRITE: 'project.write',
  PROJECT_ASSIGN: 'project.assign',
  PROJECT_DELETE: 'project.delete',
  /** Restricts a Sub-Admin to projects (and their bugs/ratings/conversations) they are assigned to manage. */
  PROJECT_SCOPE_TO_ASSIGNED: 'project.scope_to_assigned',

  // Organisations — §2.2 Organisation Management
  ORGANISATION_READ: 'organisation.read',
  ORGANISATION_WRITE: 'organisation.write',
  ORGANISATION_DELETE: 'organisation.delete',

  // Testers — §2.2 Crowd Tester Management
  TESTER_READ: 'tester.read',
  TESTER_WRITE: 'tester.write',
  TESTER_VERIFY: 'tester.verify',
  TESTER_SUSPEND: 'tester.suspend',

  // Managers — §2.2 Manager Management
  MANAGER_READ: 'manager.read',
  MANAGER_WRITE: 'manager.write',

  // Bugs
  BUG_READ: 'bug.read',
  BUG_TRIAGE: 'bug.triage',
  BUG_DELETE: 'bug.delete',

  // Communication — §2.2 Communication
  COMMUNICATION_READ: 'communication.read',
  COMMUNICATION_WRITE: 'communication.write',
  ANNOUNCEMENT_WRITE: 'announcement.write',

  // Ratings — §2.2 Ratings & Reviews
  RATING_READ: 'rating.read',
  RATING_MODERATE: 'rating.moderate',
  RATING_WRITE: 'rating.write',

  // Transactions — §2.2 Transactions
  TRANSACTION_READ: 'transaction.read',
  TRANSACTION_WRITE: 'transaction.write',
  /** Highly sensitive — reveals a tester's decrypted bank/payout details. */
  PAYMENT_ACCOUNT_DECRYPT: 'payment_account.decrypt',

  // Users & access
  USER_READ: 'user.read',
  USER_WRITE: 'user.write',
  SUBADMIN_MANAGE: 'subadmin.manage',

  // Platform
  AUDIT_READ: 'audit.read',
  STATS_READ: 'stats.read',

  // Marketing — the contact-form pipeline
  LEAD_READ: 'lead.read',
  LEAD_WRITE: 'lead.write',

  // Blog
  BLOG_READ: 'blog.read',
  BLOG_WRITE: 'blog.write',
  BLOG_PUBLISH: 'blog.publish',
  BLOG_DELETE: 'blog.delete',
  BLOG_MANAGE_CATEGORIES: 'blog.manage_categories',
  BLOG_MANAGE_TAGS: 'blog.manage_tags',

  // AI Studio — checked by AI Studio itself, never by this API. The table in
  // AI_Studio/docs/product-restructure/ACCESS_MODEL.md is the spec.
  AI_STUDIO_ACCESS: 'ai_studio.access',
  AI_STUDIO_PROJECT_CREATE: 'ai_studio.project.create',
  AI_STUDIO_PROJECT_SETTINGS: 'ai_studio.project.settings',
  AI_STUDIO_PROJECT_MEMBERS: 'ai_studio.project.members',
  AI_STUDIO_TESTS_WRITE: 'ai_studio.tests.write',
  AI_STUDIO_TESTS_GENERATE: 'ai_studio.tests.generate',
  AI_STUDIO_TESTS_APPROVE: 'ai_studio.tests.approve',
  AI_STUDIO_TESTS_RUN: 'ai_studio.tests.run',
  AI_STUDIO_AGENT_RUN: 'ai_studio.agent.run',
  AI_STUDIO_REPORTS_EXPORT: 'ai_studio.reports.export',
  AI_STUDIO_TESTS_DELETE: 'ai_studio.tests.delete',
  AI_STUDIO_RUNNERS_MANAGE: 'ai_studio.runners.manage',
  AI_STUDIO_AI_KEYS_MANAGE: 'ai_studio.ai_keys.manage',
  AI_STUDIO_USAGE_VIEW: 'ai_studio.usage.view',
  AI_STUDIO_SECURITY_USE: 'ai_studio.security.use',
  AI_STUDIO_PLATFORM_SETTINGS: 'ai_studio.platform.settings',
} as const

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const PERMISSION_CATALOGUE: PermissionDefinition[] = [
  {
    code: PERMISSIONS.PROJECT_READ,
    group: PERMISSION_GROUPS.PROJECTS,
    label: 'View projects',
    description: 'View all testing projects and their progress',
  },
  {
    code: PERMISSIONS.PROJECT_WRITE,
    group: PERMISSION_GROUPS.PROJECTS,
    label: 'Create and edit projects',
    description: 'Create, edit and change the status of projects',
  },
  {
    code: PERMISSIONS.PROJECT_ASSIGN,
    group: PERMISSION_GROUPS.PROJECTS,
    label: 'Assign testers',
    description: 'Invite, assign and remove testers on a project',
  },
  {
    code: PERMISSIONS.PROJECT_DELETE,
    group: PERMISSION_GROUPS.PROJECTS,
    label: 'Delete projects',
    description: 'Archive or delete a project and its data',
  },
  {
    code: PERMISSIONS.PROJECT_SCOPE_TO_ASSIGNED,
    group: PERMISSION_GROUPS.PROJECTS,
    label: 'Scope to assigned projects only',
    description:
      'Restrict this Sub-Admin to the projects they are assigned to manage (Managers → Assign a project), instead of every project — also narrows the bugs, ratings and conversations they can see to those same projects.',
  },

  {
    code: PERMISSIONS.ORGANISATION_READ,
    group: PERMISSION_GROUPS.ORGANISATIONS,
    label: 'View organisations',
    description: 'View customer organisations and their profiles',
  },
  {
    code: PERMISSIONS.ORGANISATION_WRITE,
    group: PERMISSION_GROUPS.ORGANISATIONS,
    label: 'Manage organisations',
    description: 'Onboard, edit and change the status of organisations',
  },
  {
    code: PERMISSIONS.ORGANISATION_DELETE,
    group: PERMISSION_GROUPS.ORGANISATIONS,
    label: 'Delete organisations',
    description: 'Archive or delete an organisation',
  },

  {
    code: PERMISSIONS.TESTER_READ,
    group: PERMISSION_GROUPS.TESTERS,
    label: 'View testers',
    description: 'View the crowd tester pool and tester profiles',
  },
  {
    code: PERMISSIONS.TESTER_WRITE,
    group: PERMISSION_GROUPS.TESTERS,
    label: 'Edit testers',
    description: 'Edit tester profiles, devices and skills',
  },
  {
    code: PERMISSIONS.TESTER_VERIFY,
    group: PERMISSION_GROUPS.TESTERS,
    label: 'Verify testers',
    description: 'Approve or reject tester applications',
  },
  {
    code: PERMISSIONS.TESTER_SUSPEND,
    group: PERMISSION_GROUPS.TESTERS,
    label: 'Suspend testers',
    description: 'Suspend or reinstate a tester',
  },

  {
    code: PERMISSIONS.MANAGER_READ,
    group: PERMISSION_GROUPS.MANAGERS,
    label: 'View managers',
    description: 'View internal managers and their project assignments',
  },
  {
    code: PERMISSIONS.MANAGER_WRITE,
    group: PERMISSION_GROUPS.MANAGERS,
    label: 'Manage managers',
    description: 'Assign and remove managers on projects',
  },

  {
    code: PERMISSIONS.BUG_READ,
    group: PERMISSION_GROUPS.BUGS,
    label: 'View bugs',
    description: 'View all bug reports across projects',
  },
  {
    code: PERMISSIONS.BUG_TRIAGE,
    group: PERMISSION_GROUPS.BUGS,
    label: 'Triage bugs',
    description: 'Change bug status, severity and mark duplicates',
  },
  {
    code: PERMISSIONS.BUG_DELETE,
    group: PERMISSION_GROUPS.BUGS,
    label: 'Delete bugs',
    description: 'Delete a bug report',
  },

  {
    code: PERMISSIONS.COMMUNICATION_READ,
    group: PERMISSION_GROUPS.COMMUNICATION,
    label: 'View conversations',
    description: 'Read message threads between customers, testers and admins',
  },
  {
    code: PERMISSIONS.COMMUNICATION_WRITE,
    group: PERMISSION_GROUPS.COMMUNICATION,
    label: 'Participate in conversations',
    description: 'Send messages and manage threads',
  },
  {
    code: PERMISSIONS.ANNOUNCEMENT_WRITE,
    group: PERMISSION_GROUPS.COMMUNICATION,
    label: 'Publish announcements',
    description: 'Create and publish platform announcements',
  },

  {
    code: PERMISSIONS.RATING_READ,
    group: PERMISSION_GROUPS.RATINGS,
    label: 'View ratings',
    description: 'View ratings and reviews',
  },
  {
    code: PERMISSIONS.RATING_MODERATE,
    group: PERMISSION_GROUPS.RATINGS,
    label: 'Moderate ratings',
    description: 'Hide or restore a rating',
  },
  {
    code: PERMISSIONS.RATING_WRITE,
    group: PERMISSION_GROUPS.RATINGS,
    label: 'Leave ratings',
    description: 'Rate a tester on a project they worked on',
  },

  {
    code: PERMISSIONS.TRANSACTION_READ,
    group: PERMISSION_GROUPS.TRANSACTIONS,
    label: 'View transactions',
    description: 'View billing and payment records',
  },
  {
    code: PERMISSIONS.TRANSACTION_WRITE,
    group: PERMISSION_GROUPS.TRANSACTIONS,
    label: 'Manage transactions',
    description: 'Record and update transactions',
  },
  {
    code: PERMISSIONS.PAYMENT_ACCOUNT_DECRYPT,
    group: PERMISSION_GROUPS.TRANSACTIONS,
    label: 'Decrypt bank details',
    description:
      'Reveal a tester’s decrypted bank/payout details. Every reveal is audited. Grant sparingly.',
  },

  {
    code: PERMISSIONS.USER_READ,
    group: PERMISSION_GROUPS.USERS,
    label: 'View users',
    description: 'View all platform user accounts',
  },
  {
    code: PERMISSIONS.USER_WRITE,
    group: PERMISSION_GROUPS.USERS,
    label: 'Manage users',
    description: 'Edit, suspend and reactivate user accounts',
  },
  {
    code: PERMISSIONS.SUBADMIN_MANAGE,
    group: PERMISSION_GROUPS.USERS,
    label: 'Manage sub-admins',
    description: 'Create sub-admins and configure their permissions',
  },

  {
    code: PERMISSIONS.AUDIT_READ,
    group: PERMISSION_GROUPS.PLATFORM,
    label: 'View audit log',
    description: 'Read the platform audit trail',
  },
  {
    code: PERMISSIONS.STATS_READ,
    group: PERMISSION_GROUPS.PLATFORM,
    label: 'View dashboard stats',
    description: 'View the admin dashboard summary figures',
  },
  {
    code: PERMISSIONS.LEAD_READ,
    group: PERMISSION_GROUPS.PLATFORM,
    label: 'View demo requests',
    description: 'Read enquiries submitted through the marketing site',
  },
  {
    code: PERMISSIONS.LEAD_WRITE,
    group: PERMISSION_GROUPS.PLATFORM,
    label: 'Manage demo requests',
    description: 'Update the status and notes on a marketing enquiry',
  },

  {
    code: PERMISSIONS.BLOG_READ,
    group: PERMISSION_GROUPS.BLOG,
    label: 'View blog posts',
    description: 'View blog posts, categories and tags in every status',
  },
  {
    code: PERMISSIONS.BLOG_WRITE,
    group: PERMISSION_GROUPS.BLOG,
    label: 'Create and edit blog posts',
    description: 'Create posts and edit their content, SEO fields and featured image',
  },
  {
    code: PERMISSIONS.BLOG_PUBLISH,
    group: PERMISSION_GROUPS.BLOG,
    label: 'Publish blog posts',
    description: 'Publish, schedule, archive and feature a blog post',
  },
  {
    code: PERMISSIONS.BLOG_DELETE,
    group: PERMISSION_GROUPS.BLOG,
    label: 'Delete blog posts',
    description: 'Delete a blog post',
  },
  {
    code: PERMISSIONS.BLOG_MANAGE_CATEGORIES,
    group: PERMISSION_GROUPS.BLOG,
    label: 'Manage blog categories',
    description: 'Create, edit and retire blog categories',
  },
  {
    code: PERMISSIONS.BLOG_MANAGE_TAGS,
    group: PERMISSION_GROUPS.BLOG,
    label: 'Manage blog tags',
    description: 'Create and edit blog tags',
  },
  {
    code: PERMISSIONS.AI_STUDIO_ACCESS,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Open AI Studio',
    description:
      'Open AI Studio from the portal and view the projects this person has been added to.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_PROJECT_CREATE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Create projects',
    description: 'Create AI Studio projects, which for a customer means in their own organisation.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_PROJECT_SETTINGS,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Change project settings',
    description: "Change a project's settings, environments and test data.",
  },
  {
    code: PERMISSIONS.AI_STUDIO_PROJECT_MEMBERS,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Manage project members',
    description: 'Add or remove people on a project and choose who is its project admin.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_TESTS_WRITE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Write tests',
    description: 'Create and edit requirements, test cases, suites and scripts.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_TESTS_GENERATE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Generate tests with AI',
    description: 'Use the AI to write tests, which spends AI usage.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_TESTS_APPROVE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Approve tests',
    description:
      'Approve test cases and script versions on projects where this person is project admin.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_TESTS_RUN,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Run tests',
    description: 'Run approved tests.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_AGENT_RUN,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Start agent runs',
    description: 'Start live AI agent runs that pursue an objective on a runner.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_REPORTS_EXPORT,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Export reports',
    description: 'Download reports, evidence and test code.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_TESTS_DELETE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Delete tests and runs',
    description: 'Delete test cases, scripts, runs and projects.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_RUNNERS_MANAGE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Manage runners',
    description:
      'Register, drain and revoke runners for their own organisation, or for every organisation for staff.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_AI_KEYS_MANAGE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Manage AI keys',
    description: "Set a project's AI configuration and customer-owned AI keys.",
  },
  {
    code: PERMISSIONS.AI_STUDIO_USAGE_VIEW,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'View AI usage and cost',
    description: 'See how much AI usage a project has spent and what it cost.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_SECURITY_USE,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Use security assessment',
    description: 'Use the security assessment module.',
  },
  {
    code: PERMISSIONS.AI_STUDIO_PLATFORM_SETTINGS,
    group: PERMISSION_GROUPS.AI_STUDIO,
    label: 'Manage AI Studio platform settings',
    description:
      'Change global AI provider policies, default models and other platform-wide settings.',
  },
]

/** Sensible starting grant for a newly created Sub-Admin. */
export const DEFAULT_SUBADMIN_PERMISSIONS: string[] = [
  PERMISSIONS.PROJECT_READ,
  PERMISSIONS.ORGANISATION_READ,
  PERMISSIONS.TESTER_READ,
  PERMISSIONS.BUG_READ,
  PERMISSIONS.COMMUNICATION_READ,
  PERMISSIONS.RATING_READ,
  /**
   * A manager runs the project day to day, so recognising the crowd who
   * worked it — a rating, and the badges that share this permission — is
   * part of the job rather than something to escalate to a full admin. The
   * write is still bounded by `assertWorkedTogether`: they can only speak
   * about testers who genuinely worked the project.
   */
  PERMISSIONS.RATING_WRITE,
  PERMISSIONS.STATS_READ,
  // A sub-admin who cannot see incoming enquiries cannot do sales triage, which
  // is most of what the role is for.
  PERMISSIONS.LEAD_READ,
  PERMISSIONS.BLOG_READ,
]
