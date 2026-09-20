import { describe, expect, it, vi } from 'vitest'
import { inviteEmployees } from '../../src/modules/hrms/hr-auth.service.js'
import { BadRequestError, InternalError, NotFoundError } from '../../src/lib/errors.js'

const okSender = () => vi.fn((id: string) => Promise.resolve({ email: `${id}@example.test` }))

describe('inviteEmployees', () => {
  it('sends to everyone and reports each address', async () => {
    const send = okSender()
    const result = await inviteEmployees(['a', 'b'], 'admin', send)

    expect(result.sent).toEqual([
      { id: 'a', email: 'a@example.test' },
      { id: 'b', email: 'b@example.test' },
    ])
    expect(result.failed).toEqual([])
    expect(send).toHaveBeenCalledWith('a', 'admin')
  })

  it('sends only one link to someone ticked twice', async () => {
    const send = okSender()
    await inviteEmployees(['a', 'a', 'b'], 'admin', send)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('records a stated refusal against that person and still sends the rest', async () => {
    const send = vi.fn((id: string) => {
      if (id === 'left') {
        return Promise.reject(new BadRequestError('Only an active employee can be invited'))
      }
      if (id === 'gone') return Promise.reject(new NotFoundError('Employee'))
      return Promise.resolve({ email: `${id}@example.test` })
    })

    const result = await inviteEmployees(['a', 'left', 'gone', 'b'], 'admin', send)

    expect(result.sent.map((s) => s.id)).toEqual(['a', 'b'])
    expect(result.failed.map((f) => f.id)).toEqual(['left', 'gone'])
    expect(result.failed[0]?.reason).toBe('Only an active employee can be invited')
  })

  it('does not swallow a server fault', async () => {
    const send = vi.fn(() => Promise.reject(new InternalError('database is down')))
    await expect(inviteEmployees(['a'], 'admin', send)).rejects.toThrow('database is down')
  })

  it('does not swallow an unexpected error', async () => {
    const send = vi.fn(() => Promise.reject(new TypeError('boom')))
    await expect(inviteEmployees(['a'], 'admin', send)).rejects.toThrow('boom')
  })
})
