import { prisma } from '../prisma.js'
import { ForbiddenError } from '../errors.js'

/**
 * For the handful of actions that move money or act on another party's
 * behalf — not a blanket gate, which would contradict the deliberately
 * low-friction signup flow (`register()` in auth.service.ts opens a session
 * immediately, and the pending-verification status never blocks login).
 *
 * Lives here, not in auth.service.ts, specifically to avoid a circular
 * import: auth.service.ts already imports from both testers.service.ts and
 * organisations.service.ts (to cascade a verified email into each), and this
 * is needed BY organisations.service.ts in the other direction.
 *
 * `req.user` (`Express.AuthenticatedUser`) never carries `emailVerifiedAt`,
 * so this is always a fresh read rather than trusting anything pre-attached
 * to the request.
 */
export async function assertEmailVerified(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  })
  if (!user?.emailVerifiedAt) {
    throw new ForbiddenError('Verify your email address first')
  }
}
