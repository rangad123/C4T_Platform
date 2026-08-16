import { requireRole } from '@/lib/auth/session'
import { serverFetchOrNull } from '@/lib/api/server'
import { Panel } from '@/components/admin/Panel'
import { Badge } from '@/components/ds/core/Badge'
import { EmptyState } from '@/components/ds/admin/EmptyState'
import { titleCase } from '@/lib/admin/format'
import { setSkillCategoryAction } from './actions'

const SKILL_CATEGORIES = ['DOMAIN', 'TYPE', 'TOOL', 'APPLICATION'] as const

const CATEGORY_TONE: Record<(typeof SKILL_CATEGORIES)[number], 'brand' | 'info' | 'accent' | 'neutral'> = {
  DOMAIN: 'brand',
  TYPE: 'info',
  TOOL: 'accent',
  APPLICATION: 'neutral',
}

const CATEGORY_DESCRIPTION: Record<(typeof SKILL_CATEGORIES)[number], string> = {
  DOMAIN: 'A market or product area the tester has worked in (e.g. Fintech, Gaming).',
  TYPE: 'A testing discipline (e.g. Accessibility, Performance).',
  TOOL: 'A tool the tester knows (e.g. Charles Proxy, Postman).',
  APPLICATION: 'A product or app the tester has hands-on with (e.g. iOS Safari).',
}

interface SkillRow {
  id: string
  name: string
  slug: string
  category: (typeof SKILL_CATEGORIES)[number]
  _count: { testers: number }
}

/**
 * `/app/admin/skills` — the skill catalogue browser.
 *
 * The data model is flat: every skill has a name, a slug, and one of four
 * taxonomy categories (Domain / Type / Tool / Application). New skills are
 * created implicitly when a tester types a fresh slug into their profile —
 * the admin job here is to keep the catalogue tidy by re-classifying
 * legacy free-text skills that landed in the wrong bucket.
 *
 * Page is a Server Component: it lists every skill, grouped by category,
 * and each row has its own form to set the category. No client JS for the
 * page itself; the only interactive bits are the per-row selects.
 */
export default async function SkillsPage() {
  await requireRole(['ADMIN', 'SUB_ADMIN'])

  const skills = await serverFetchOrNull<readonly SkillRow[]>('testers/skills/catalogue')

  if (!skills) {
    return (
      <Panel title="Skills">
        <EmptyState
          icon="briefcase"
          title="Skill catalogue is not reachable"
          description="Your account has tester.read but the catalogue endpoint needs the admin tester.read scope."
        />
      </Panel>
    )
  }

  const grouped = SKILL_CATEGORIES.map((category) => ({
    category,
    skills: skills.filter((s) => s.category === category),
  }))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 'var(--space-4)',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 'var(--type-body-sm-size)',
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 'var(--fw-semibold)',
            }}
          >
            Accounts
          </div>
          <h1
            style={{
              margin: 'var(--space-2) 0 0',
              fontSize: 'var(--type-heading-lg-size)',
              fontWeight: 'var(--fw-semibold)',
              lineHeight: 1.15,
            }}
          >
            Skill catalogue
          </h1>
          <p
            style={{
              margin: 'var(--space-3) 0 0',
              maxWidth: 720,
              color: 'var(--text-secondary)',
              lineHeight: 1.55,
            }}
          >
            Every skill the platform has, grouped by the kind of thing it is. The
            taxonomy matters when matching testers to projects — a tester who knows
            Charles Proxy (a Tool) is filtered by tool, not by domain.
          </p>
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--type-body-sm-size)' }}>
          {skills.length} skill{skills.length === 1 ? '' : 's'} ·{' '}
          {skills.reduce((acc, s) => acc + s._count.testers, 0)} assignments
        </div>
      </header>

      {grouped.map(({ category, skills: items }) => (
        <Panel
          key={category}
          title={titleCase(category)}
          description={CATEGORY_DESCRIPTION[category]}
        >
          {items.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 'var(--type-body-sm-size)' }}>
              No skills in this category yet.
            </p>
          ) : (
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-3)',
              }}
            >
              {items.map((skill) => (
                <li
                  key={skill.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr auto auto',
                    gap: 'var(--space-4)',
                    alignItems: 'center',
                    padding: 'var(--space-3) var(--space-4)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-card)',
                    background: 'var(--surface-canvas)',
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontWeight: 'var(--fw-semibold)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      {skill.name}
                    </div>
                    <div
                      style={{
                        fontSize: 'var(--type-body-sm-size)',
                        color: 'var(--text-muted)',
                      }}
                    >
                      {skill.slug} ·{' '}
                      {skill._count.testers === 0
                        ? 'no testers'
                        : `${skill._count.testers} tester${skill._count.testers === 1 ? '' : 's'}`}
                    </div>
                  </div>
                  <Badge tone={CATEGORY_TONE[category]} uppercase={false}>
                    Current: {titleCase(skill.category)}
                  </Badge>
                  <form
                    action={setSkillCategoryAction}
                    style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
                  >
                    <input type="hidden" name="skillId" value={skill.id} />
                    <select
                      name="category"
                      defaultValue={skill.category}
                      style={{
                        padding: 'var(--space-2) var(--space-3)',
                        border: '1px solid var(--border-default)',
                        borderRadius: 'var(--radius-input)',
                        background: 'var(--surface-canvas)',
                        color: 'var(--text-primary)',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      {SKILL_CATEGORIES.map((value) => (
                        <option key={value} value={value}>
                          {titleCase(value)}
                        </option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      style={{
                        padding: 'var(--space-2) var(--space-3)',
                        border: '1px solid var(--border-default)',
                        borderRadius: 'var(--radius-input)',
                        background: 'var(--accent-base)',
                        color: 'var(--ink-50)',
                        fontWeight: 'var(--fw-semibold)',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      Save
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      ))}
    </div>
  )
}
