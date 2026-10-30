/**
 * AI Studio access, as the admin panel presents it.
 *
 * The API owns the rules — which codes a customer, tester or sub-admin may
 * hold (`GET users/permissions/catalogue?grantableTo=`) and the refusal when a
 * forbidden one is sent anyway. This module only holds what is presentation:
 * the order the features are listed in and the presets.
 *
 * Presets are shortcuts that tick boxes in the editor. They are not stored
 * anywhere, and the admin can change any box before saving (ACCESS_MODEL.md).
 */

export type AiStudioAccountKind = 'CUSTOMER' | 'TESTER' | 'SUB_ADMIN'

export function isAiStudioAccountKind(role: string): role is AiStudioAccountKind {
  return role === 'CUSTOMER' || role === 'TESTER' || role === 'SUB_ADMIN'
}

export function isAiStudioCode(code: string): boolean {
  return code.startsWith('ai_studio.')
}

/** The order of the table in ACCESS_MODEL.md, so the list reads as the spec does. */
export const AI_STUDIO_CODE_ORDER: readonly string[] = [
  'ai_studio.access',
  'ai_studio.project.create',
  'ai_studio.project.settings',
  'ai_studio.project.members',
  'ai_studio.tests.write',
  'ai_studio.tests.generate',
  'ai_studio.tests.approve',
  'ai_studio.tests.run',
  'ai_studio.agent.run',
  'ai_studio.reports.export',
  'ai_studio.tests.delete',
  'ai_studio.runners.manage',
  'ai_studio.ai_keys.manage',
  'ai_studio.usage.view',
  'ai_studio.security.use',
  'ai_studio.platform.settings',
]

export function compareAiStudioCodes(a: string, b: string): number {
  const rank = (code: string) => {
    const index = AI_STUDIO_CODE_ORDER.indexOf(code)
    return index < 0 ? AI_STUDIO_CODE_ORDER.length : index
  }
  return rank(a) - rank(b) || a.localeCompare(b)
}

export interface AiStudioPreset {
  value: string
  label: string
  codes: readonly string[]
}

const VIEW_RESULTS = ['ai_studio.access', 'ai_studio.reports.export']

export const AI_STUDIO_PRESETS: readonly AiStudioPreset[] = [
  { value: 'customer-view', label: 'Customer: view results', codes: VIEW_RESULTS },
  {
    value: 'customer-test',
    label: 'Customer: test',
    codes: [
      ...VIEW_RESULTS,
      'ai_studio.project.create',
      'ai_studio.project.settings',
      'ai_studio.project.members',
      'ai_studio.tests.write',
      'ai_studio.tests.generate',
      'ai_studio.tests.run',
      'ai_studio.agent.run',
      'ai_studio.tests.approve',
      'ai_studio.usage.view',
    ],
  },
  {
    value: 'tester-write-run',
    label: 'Tester: write and run',
    codes: [
      'ai_studio.access',
      'ai_studio.project.settings',
      'ai_studio.tests.write',
      'ai_studio.tests.generate',
      'ai_studio.tests.run',
      'ai_studio.agent.run',
      'ai_studio.reports.export',
    ],
  },
  {
    value: 'manager-full',
    label: 'Manager: full',
    codes: AI_STUDIO_CODE_ORDER.filter((code) => code !== 'ai_studio.platform.settings'),
  },
]

/** The presets named for this kind of account. */
const PRESETS_FOR: Record<AiStudioAccountKind, readonly string[]> = {
  CUSTOMER: ['customer-view', 'customer-test'],
  TESTER: ['tester-write-run'],
  SUB_ADMIN: ['manager-full'],
}

export function presetsFor(kind: AiStudioAccountKind): readonly AiStudioPreset[] {
  return AI_STUDIO_PRESETS.filter((preset) => PRESETS_FOR[kind].includes(preset.value))
}
