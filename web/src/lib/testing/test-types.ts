/**
 * The kinds of testing a build can be run as.
 *
 * `Build.testType` is free text on purpose (see the schema note) — there is
 * no admin-managed list to read, so this is a starting vocabulary rather than
 * a constraint, and the field accepts anything the API's 120-character limit
 * allows.
 *
 * Shared rather than declared twice. The customer wizard and the admin's
 * create-project form both offer it, and two copies of a nine-item list is
 * two copies to drift: a type added for customers but not admins would look
 * like a bug in whichever form lacked it.
 */
export const TEST_TYPES = [
  'Exploratory testing',
  'Functional testing',
  'Usability testing',
  'Regression testing',
  'Compatibility testing',
  'Performance testing',
  'Security testing',
  'Localization testing',
  'Accessibility testing',
] as const

/** Options for a `<Select>`, with the empty choice the API treats as unset. */
export const TEST_TYPE_OPTIONS = [
  { value: '', label: 'Not specified' },
  ...TEST_TYPES.map((type) => ({ value: type, label: type })),
]
