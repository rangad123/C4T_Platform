import { Card, CardGrid } from '@/components/admin/Card'
import { StatusBadge } from '@/components/admin/StatusBadge'
import { HrAvatar } from '@/components/hrms/HrAvatar'
import { Icon } from '@/components/ds/core/Icon'

export interface HrEmployeeCardRow {
  id: string
  employeeCode: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  role: 'ADMIN' | 'ACCOUNT_MANAGER' | 'EMPLOYEE'
  status: 'ACTIVE' | 'RESIGNED' | 'TERMINATED'
  profilePictureFileId: string | null
  designation: { id: string; name: string } | null
}

/**
 * The staff list as cards — a photo, a name, what they do and how to reach
 * them, which is what the old HR system's landing page showed and what a table
 * of the same people does not: you recognise a colleague by their face faster
 * than by their employee code.
 *
 * Contact lines are plain text, not `mailto:`/`tel:` links. The whole card is
 * already a link to the record, and an anchor inside an anchor is invalid
 * HTML that breaks hydration — see `Card`'s own note on `actions`.
 */
export function HrEmployeeCards({
  rows,
  basePath,
}: {
  rows: readonly HrEmployeeCardRow[]
  basePath: string
}) {
  return (
    <CardGrid min={280}>
      {rows.map((row) => {
        const name = `${row.firstName} ${row.lastName}`.trim()
        return (
          <Card
            key={row.id}
            href={`${basePath}/${row.id}`}
            title={
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  minWidth: 0,
                }}
              >
                <HrAvatar name={name} fileId={row.profilePictureFileId} size="md" />
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block' }}>{name}</span>
                  <span
                    style={{
                      display: 'block',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 'var(--type-caption-size)',
                      color: 'var(--text-muted)',
                      fontWeight: 400,
                    }}
                  >
                    {row.employeeCode}
                  </span>
                </span>
              </span>
            }
            meta={row.designation?.name ?? 'No designation'}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                fontSize: 'var(--type-body-sm-size)',
                color: 'var(--text-secondary)',
                minWidth: 0,
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  minWidth: 0,
                }}
              >
                <Icon name="mail" size={16} style={{ flex: 'none' }} />
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {row.email}
                </span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <Icon name="phone" size={16} style={{ flex: 'none' }} />
                {row.phone ?? '—'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <StatusBadge status={row.role} />
              <StatusBadge status={row.status} />
            </div>
          </Card>
        )
      })}
    </CardGrid>
  )
}
