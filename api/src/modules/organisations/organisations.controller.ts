import type { Request, Response } from 'express'
import { sendMail, teamInvitationEmail } from '../../lib/mailer.js'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import * as service from './organisations.service.js'
import type { ListOrganisationsQuery } from './organisations.schema.js'

export async function listInvitations(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.listInvitations(req.user!, param(req, 'id')) })
}

export async function inviteMember(req: Request, res: Response): Promise<void> {
  const { invitation, token, organisationName, invitedByName } = await service.inviteMember(
    req.user!,
    param(req, 'id'),
    req.body,
  )

  /**
   * The email is sent here rather than in the service so a mail failure never
   * rolls back the invitation — the row is the record, and the owner can
   * resend. The raw token exists only in this scope and in the message.
   */
  await sendMail(
    teamInvitationEmail(
      invitation.email,
      token,
      organisationName,
      invitedByName,
      invitation.message,
    ),
  ).catch(() => {
    // Logged by the mailer. The invitation stands; the owner can resend it.
  })

  await recordAudit({
    req,
    action: 'organisation.member_invited',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    // Deliberately no token in the audit trail.
    after: { email: invitation.email, orgRole: invitation.orgRole },
  })

  res.status(201).json({ data: invitation })
}

export async function revokeInvitation(req: Request, res: Response): Promise<void> {
  const invitation = await service.revokeInvitation(
    req.user!,
    param(req, 'id'),
    param(req, 'invitationId'),
  )
  await recordAudit({
    req,
    action: 'organisation.invitation_revoked',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    after: { email: invitation.email },
  })
  res.json({ data: invitation })
}

export async function acceptInvitation(req: Request, res: Response): Promise<void> {
  const result = await service.acceptInvitation(req.user!, req.body.token)
  await recordAudit({
    req,
    action: 'organisation.invitation_accepted',
    entityType: 'Organisation',
    entityId: result.organisation.id,
    after: { orgRole: result.orgRole },
  })
  res.json({ data: result })
}

export async function list(req: Request, res: Response): Promise<void> {
  const query = validatedQuery<ListOrganisationsQuery>(res)
  const { items, meta } = await service.listOrganisations(req.user!, query)
  res.json({ data: items, meta })
}

export async function listMine(req: Request, res: Response): Promise<void> {
  const items = await service.listMyOrganisations(req.user!.id)
  res.json({ data: items })
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const org = await service.getOrganisation(req.user!, param(req, 'id'))
  res.json({ data: org })
}

export async function create(req: Request, res: Response): Promise<void> {
  const org = await service.createOrganisation(req.body)
  await recordAudit({
    req,
    action: 'organisation.created',
    entityType: 'Organisation',
    entityId: org.id,
    after: org,
  })
  res.status(201).json({ data: org })
}

export async function update(req: Request, res: Response): Promise<void> {
  const org = await service.updateOrganisation(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'organisation.updated',
    entityType: 'Organisation',
    entityId: org.id,
    after: org,
  })
  res.json({ data: org })
}

export async function archive(req: Request, res: Response): Promise<void> {
  const org = await service.archiveOrganisation(param(req, 'id'))
  await recordAudit({
    req,
    action: 'organisation.archived',
    entityType: 'Organisation',
    entityId: org.id,
  })
  res.json({ data: org })
}

export async function addMember(req: Request, res: Response): Promise<void> {
  const member = await service.addMember(req.user!, param(req, 'id'), req.body)
  await recordAudit({
    req,
    action: 'organisation.member_added',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    after: member,
  })
  res.status(201).json({ data: member })
}

export async function updateMember(req: Request, res: Response): Promise<void> {
  const member = await service.updateMember(
    req.user!,
    param(req, 'id'),
    param(req, 'userId'),
    req.body.orgRole,
  )
  await recordAudit({
    req,
    action: 'organisation.member_role_changed',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    after: member,
  })
  res.json({ data: member })
}

export async function removeMember(req: Request, res: Response): Promise<void> {
  await service.removeMember(req.user!, param(req, 'id'), param(req, 'userId'))
  await recordAudit({
    req,
    action: 'organisation.member_removed',
    entityType: 'Organisation',
    entityId: param(req, 'id'),
    before: { userId: req.params.userId },
  })
  res.status(204).send()
}
