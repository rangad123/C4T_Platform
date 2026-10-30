import { describe, expect, it, vi } from 'vitest'
import { PERMISSION_CATALOGUE } from '../../src/config/permissions.js'
import { syncPermissionCatalogue } from '../../src/lib/permission-catalogue.js'

type Client = Parameters<typeof syncPermissionCatalogue>[0]

/** The mocks are returned beside the client so assertions never detach a method. */
function clientWith(rows: { code: string; group: string; label: string; description: string }[]) {
  const findMany = vi.fn().mockResolvedValue(rows)
  const createMany = vi.fn().mockResolvedValue({ count: 0 })
  const update = vi.fn().mockResolvedValue({})
  const client = { permission: { findMany, createMany, update } } as unknown as Client
  return { client, createMany, update }
}

describe('syncPermissionCatalogue', () => {
  it('inserts every code a fresh table lacks', async () => {
    const { client, createMany } = clientWith([])
    const result = await syncPermissionCatalogue(client)
    expect(result).toEqual({ created: PERMISSION_CATALOGUE.length, updated: 0 })
    expect(createMany).toHaveBeenCalledWith({
      data: PERMISSION_CATALOGUE,
      skipDuplicates: true,
    })
  })

  it('adds only the new codes to a table seeded before AI Studio', async () => {
    const before = PERMISSION_CATALOGUE.filter((p) => !p.code.startsWith('ai_studio.'))
    const { client, createMany, update } = clientWith(before)
    const result = await syncPermissionCatalogue(client)
    expect(result).toEqual({ created: 16, updated: 0 })
    const call = createMany.mock.calls[0]![0] as { data: { code: string }[] }
    expect(call.data.every((p) => p.code.startsWith('ai_studio.'))).toBe(true)
    expect(update).not.toHaveBeenCalled()
  })

  it('refreshes a changed label and writes nothing when in sync', async () => {
    const rows = PERMISSION_CATALOGUE.map((p) => ({ ...p }))
    rows[0]!.label = 'An old label'
    const { client, update } = clientWith(rows)
    expect(await syncPermissionCatalogue(client)).toEqual({ created: 0, updated: 1 })
    expect(update).toHaveBeenCalledWith({
      where: { code: PERMISSION_CATALOGUE[0]!.code },
      data: {
        group: PERMISSION_CATALOGUE[0]!.group,
        label: PERMISSION_CATALOGUE[0]!.label,
        description: PERMISSION_CATALOGUE[0]!.description,
      },
    })

    const synced = clientWith(PERMISSION_CATALOGUE.map((p) => ({ ...p })))
    expect(await syncPermissionCatalogue(synced.client)).toEqual({ created: 0, updated: 0 })
    expect(synced.createMany).not.toHaveBeenCalled()
    expect(synced.update).not.toHaveBeenCalled()
  })
})
