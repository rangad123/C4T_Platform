/**
 * §2.2 "Sub-Admin Permissions" — the catalogue of capabilities an Admin can
 * delegate to a Sub-Admin.
 *
 * ADMIN implicitly holds every permission and is never checked against this
 * table. SUB_ADMIN holds only what has been explicitly granted.
 * CUSTOMER and TESTER are not permission-driven at all: their access is scoped
 * by ownership (own organisation, own assignments), enforced in the services.
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
]

/** Sensible starting grant for a newly created Sub-Admin. */
export const DEFAULT_SUBADMIN_PERMISSIONS: string[] = [
  PERMISSIONS.PROJECT_READ,
  PERMISSIONS.ORGANISATION_READ,
  PERMISSIONS.TESTER_READ,
  PERMISSIONS.BUG_READ,
  PERMISSIONS.COMMUNICATION_READ,
  PERMISSIONS.RATING_READ,
  PERMISSIONS.STATS_READ,
  // A sub-admin who cannot see incoming enquiries cannot do sales triage, which
  // is most of what the role is for.
  PERMISSIONS.LEAD_READ,
]
