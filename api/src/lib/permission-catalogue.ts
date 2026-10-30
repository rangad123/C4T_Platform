import type { PrismaClient } from '@prisma/client'
import { PERMISSION_CATALOGUE } from '../config/permissions.js'

/**
 * Brings the `permissions` table in line with the in-code catalogue: inserts
 * codes it lacks and refreshes the group, label and description of the rest.
 * Never deletes — a code removed from the catalogue keeps its grant rows until
 * someone migrates them deliberately.
 *
 * Run at every API start, not only by `db:seed`. The deploy never touches the
 * database (scripts/deploy.sh), so a new code used to need a manual seed on the
 * box; until someone ran it, the admin panel offered the code from the in-code
 * fallback and then refused to grant it as unknown. Idempotent, and cheap once
 * in sync: one read and no writes.
 */
export async function syncPermissionCatalogue(
  client: Pick<PrismaClient, 'permission'>,
): Promise<{ created: number; updated: number }> {
  const existing = await client.permission.findMany({
    select: { code: true, group: true, label: true, description: true },
  })
  const byCode = new Map(existing.map((row) => [row.code, row]))

  const missing = PERMISSION_CATALOGUE.filter((entry) => !byCode.has(entry.code))
  const changed = PERMISSION_CATALOGUE.filter((entry) => {
    const row = byCode.get(entry.code)
    return (
      row !== undefined &&
      (row.group !== entry.group ||
        row.label !== entry.label ||
        row.description !== entry.description)
    )
  })

  if (missing.length > 0) {
    // skipDuplicates: a second process starting at the same moment is harmless.
    await client.permission.createMany({ data: missing, skipDuplicates: true })
  }
  for (const entry of changed) {
    await client.permission.update({
      where: { code: entry.code },
      data: { group: entry.group, label: entry.label, description: entry.description },
    })
  }

  return { created: missing.length, updated: changed.length }
}
