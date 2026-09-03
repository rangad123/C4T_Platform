import { Router } from 'express'
import { z } from 'zod'
import { LeadStatus, Role, type Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { searchTerms } from '../../lib/search.js'
import { param } from '../../lib/http.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/authorize.js'
import { clientAddress, leadLimiter } from '../../middleware/rateLimit.js'
import { validate, validatedQuery } from '../../middleware/validate.js'
import { buildMeta, paginationQuery, toSkipTake } from '../../lib/pagination.js'
import { phoneField } from '../../lib/phone.js'
import { NotFoundError } from '../../lib/errors.js'
import { recordAudit } from '../../lib/audit.js'
import { createNotifications } from '../notifications/notifications.service.js'
import { PERMISSIONS } from '../../config/permissions.js'

/**
 * Marketing enquiries from the website's contact form.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * WHY THIS MODULE IS SHAPED DIFFERENTLY FROM EVERY OTHER ONE
 *
 * `POST /v1/leads` is the ONLY unauthenticated write on the API. Every other
 * route in this service starts with `authenticate`; this one cannot, because the
 * person submitting it is a stranger who does not have an account and is
 * enquiring about getting one.
 *
 * That single fact drives the rest:
 *
 *   - The router does NOT call `authenticate` at the top. The two admin routes
 *     apply it individually, so adding a route to this file without thinking
 *     leaves it public — hence this note, and hence the ordering below with the
 *     public route first and clearly marked.
 *   - `leadLimiter` before the handler: 5/hour/IP. `globalLimiter` allows 300 per
 *     window, which is a spam budget, not a form budget.
 *   - Every string is length-capped in Zod before it reaches the database.
 *   - A honeypot hit is accepted and stored as SPAM rather than rejected. Telling
 *     a bot what tripped it just teaches the next version, and a 200 costs
 *     nothing. Storing them means the filter can be tuned against real traffic.
 *   - Admins are notified on arrival. A lead nobody sees is the same as a lead
 *     that was never submitted, which is the failure this endpoint exists to fix.
 *
 * The web app posts to this from a server action, so the browser never calls it
 * directly and no CORS entry is needed.
 * ──────────────────────────────────────────────────────────────────────────
 */
export const leadsRouter = Router()

/**
 * An optional text field as the column wants it.
 *
 * Every string here is `.trim()`ed by zod and `phoneField` accepts `''`
 * outright, so "absent" arrives as either `undefined` or an empty string and
 * both mean the same thing to a nullable column. Spelled out rather than
 * written `value || null`, which reads as a nullish slip.
 */
function blankToNull(value: string | undefined): string | null {
  if (value === undefined || value === '') return null
  return value
}

/* ─── Public: submit an enquiry ─────────────────────────────────────────────── */

/**
 * Mirrors the form in `web/src/components/ds/marketing/ContactForm.tsx`. The web
 * server action validates first for a fast, per-field error response; this is the
 * boundary that actually matters, because the action is not the only thing that
 * can reach this URL.
 */
const createLeadBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  phone: phoneField.optional(),
  company: z.string().trim().min(1).max(160),
  teamSize: z.string().trim().max(40).optional(),
  message: z.string().trim().max(4000).optional(),
  marketingConsent: z.boolean().default(false),
  sourcePath: z.string().trim().max(200).optional(),
  /**
   * The honeypot. A real submitter never sees this field, so any value in it is
   * automated. Accepted, then filed as SPAM — see the note above.
   */
  honeypot: z.string().max(200).optional(),
})

leadsRouter.post('/', leadLimiter, validate({ body: createLeadBody }), async (req, res) => {
  const body = req.body as z.infer<typeof createLeadBody>
  const isSpam = Boolean(body.honeypot && body.honeypot.length > 0)

  const lead = await prisma.lead.create({
    data: {
      firstName: body.firstName,
      lastName: body.lastName,
      email: body.email,
      phone: blankToNull(body.phone),
      company: body.company,
      teamSize: body.teamSize ?? null,
      message: body.message ?? null,
      marketingConsent: body.marketingConsent,
      sourcePath: body.sourcePath ?? null,
      status: isSpam ? LeadStatus.SPAM : LeadStatus.NEW,
      // Personal data, kept for abuse triage only. Covered by the retention
      // policy — see the note on the model.
      //
      // `clientAddress`, not `req.ip`: the form submits through a server
      // action, so `req.ip` is our own web tier and this column recorded the
      // same address for every enquiry — useless for the one thing it exists
      // for.
      ipAddress: clientAddress(req),
      userAgent: req.get('user-agent')?.slice(0, 500) ?? null,
    },
    select: { id: true, status: true, createdAt: true },
  })

  if (!isSpam) {
    // Fire-and-forget by design: `createNotifications` swallows its own errors,
    // and a notification failure must never turn a captured lead into a 500 that
    // makes the visitor submit again.
    const admins = await prisma.user.findMany({
      where: { role: { in: [Role.ADMIN, Role.SUB_ADMIN] }, deletedAt: null },
      select: { id: true },
    })
    await createNotifications(
      admins.map((a) => a.id),
      {
        type: 'SYSTEM',
        title: 'New demo request',
        body: `${body.firstName} ${body.lastName} at ${body.company}`,
        link: `/app/leads/${lead.id}`,
        metadata: { leadId: lead.id },
      },
    )
  }

  /**
   * 201 with the id and nothing else. The submitter gets no read access to what
   * was stored, and the response is identical for a spam hit — a differing shape
   * would tell a bot it was caught.
   */
  res.status(201).json({ data: { id: lead.id, createdAt: lead.createdAt } })
})

/* ─── Admin: read and triage ────────────────────────────────────────────────── */

const leadSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  company: true,
  teamSize: true,
  message: true,
  marketingConsent: true,
  status: true,
  notes: true,
  sourcePath: true,
  convertedOrgId: true,
  createdAt: true,
  updatedAt: true,
  convertedOrg: { select: { id: true, name: true } },
} satisfies Prisma.LeadSelect

const listQuery = paginationQuery.extend({
  status: z.nativeEnum(LeadStatus).optional(),
  /** Substring match on name, email or company. */
  search: z.string().trim().max(120).optional(),
})

leadsRouter.get(
  '/',
  authenticate,
  requirePermission(PERMISSIONS.LEAD_READ),
  validate({ query: listQuery }),
  async (req, res) => {
    const query = validatedQuery<z.infer<typeof listQuery>>(res)
    const { skip, take } = toSkipTake(query)

    const where: Prisma.LeadWhereInput = {
      // Spam is excluded unless explicitly asked for. It is kept for tuning the
      // filter, not for reading every morning.
      ...(query.status ? { status: query.status } : { status: { not: LeadStatus.SPAM } }),
      /** Every term must match some column — see `searchTerms`. */
      ...(searchTerms(query.search).length > 0
        ? {
            AND: searchTerms(query.search).map((term) => ({
              OR: [
                { firstName: { contains: term, mode: 'insensitive' as const } },
                { lastName: { contains: term, mode: 'insensitive' as const } },
                { email: { contains: term, mode: 'insensitive' as const } },
                { company: { contains: term, mode: 'insensitive' as const } },
              ],
            })),
          }
        : {}),
    }

    const [items, total] = await Promise.all([
      prisma.lead.findMany({
        where,
        select: leadSelect,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.lead.count({ where }),
    ])

    res.json({ data: items, meta: buildMeta(query, total) })
  },
)

leadsRouter.get(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.LEAD_READ),
  async (req, res) => {
    const lead = await prisma.lead.findUnique({
      where: { id: param(req, 'id') },
      select: leadSelect,
    })
    if (!lead) throw new NotFoundError('Lead not found')
    res.json({ data: lead })
  },
)

/**
 * Admin-created leads — an enquiry that arrived somewhere the form is not.
 *
 * A call, a conference, an email to a salesperson: the pipeline is only worth
 * measuring if every lead is in it, and until now the only way into this table
 * was the marketing form. Same fields as that form, deliberately, so the two
 * kinds of lead are comparable rather than two shapes of record.
 *
 * Separate from the public `POST /` rather than sharing it, because three
 * things genuinely differ and each would be wrong the other way round:
 *
 *  - It authenticates and requires `lead.write`, where the public route cannot
 *    authenticate at all.
 *  - No rate limit. `leadLimiter` exists to stop a bot filling the table; an
 *    admin typing in leads after a conference is exactly the traffic it would
 *    block.
 *  - No "New demo request" notification. It would tell the person who just
 *    created the lead about their own typing, and bury the arrivals that
 *    nobody has seen yet.
 *
 * No honeypot either: there is no bot on this side of the login.
 */
const createLeadByAdminBody = createLeadBody.omit({ honeypot: true, sourcePath: true }).extend({
  status: z.nativeEnum(LeadStatus).optional(),
  notes: z.string().trim().max(4000).optional(),
})

leadsRouter.post(
  '/manual',
  authenticate,
  requirePermission(PERMISSIONS.LEAD_WRITE),
  validate({ body: createLeadByAdminBody }),
  async (req, res) => {
    const body = req.body as z.infer<typeof createLeadByAdminBody>

    const lead = await prisma.lead.create({
      data: {
        firstName: body.firstName,
        lastName: body.lastName,
        email: body.email,
        phone: blankToNull(body.phone),
        company: body.company,
        teamSize: blankToNull(body.teamSize),
        message: blankToNull(body.message),
        marketingConsent: body.marketingConsent,
        notes: blankToNull(body.notes),
        status: body.status ?? LeadStatus.NEW,
        /**
         * How this lead got here, in the same field the form fills with the
         * page it was submitted from. Without it a hand-entered lead is
         * indistinguishable from a form submission, and conversion rates
         * measured off this table would be quietly wrong.
         */
        sourcePath: 'admin',
      },
      select: leadSelect,
    })

    await recordAudit({
      req,
      action: 'lead.created',
      entityType: 'Lead',
      entityId: lead.id,
      after: lead,
    })

    res.status(201).json({ data: lead })
  },
)

const updateLeadBody = z.object({
  status: z.nativeEnum(LeadStatus).optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
  convertedOrgId: z.string().cuid().nullable().optional(),
})

leadsRouter.patch(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.LEAD_WRITE),
  validate({ body: updateLeadBody }),
  async (req, res) => {
    const id = param(req, 'id')
    const body = req.body as z.infer<typeof updateLeadBody>

    const before = await prisma.lead.findUnique({ where: { id }, select: leadSelect })
    if (!before) throw new NotFoundError('Lead not found')

    const lead = await prisma.lead.update({
      where: { id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.convertedOrgId !== undefined ? { convertedOrgId: body.convertedOrgId } : {}),
      },
      select: leadSelect,
    })

    // Audited because it is the record of who decided a prospect was lost, and
    // because `notes` is where someone will eventually write something they
    // would rather stand behind.
    await recordAudit({
      req,
      action: 'lead.updated',
      entityType: 'Lead',
      entityId: id,
      before,
      after: lead,
    })

    res.json({ data: lead })
  },
)
