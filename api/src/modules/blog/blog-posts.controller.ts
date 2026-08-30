import type { Request, Response } from 'express'
import { param } from '../../lib/http.js'
import { recordAudit } from '../../lib/audit.js'
import { validatedQuery } from '../../middleware/validate.js'
import * as service from './blog-posts.service.js'
import type { AdminListPostsQuery, PublicListPostsQuery } from './blog-posts.schema.js'

// ─── Public ────────────────────────────────────────────────────────────────

export async function listPublic(req: Request, res: Response): Promise<void> {
  const result = await service.listPostsPublic(validatedQuery<PublicListPostsQuery>(res))
  res.json({ data: result.items, meta: result.meta })
}

export async function getPublic(req: Request, res: Response): Promise<void> {
  const { post, redirectTo } = await service.getPostPublic(param(req, 'slug'))
  res.json({ data: post, redirectTo: redirectTo ?? null })
}

// ─── Admin ─────────────────────────────────────────────────────────────────

export async function preview(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.getPostPreview(param(req, 'slug')) })
}

export async function listAdmin(req: Request, res: Response): Promise<void> {
  const result = await service.listPostsAdmin(validatedQuery<AdminListPostsQuery>(res))
  res.json({ data: result.items, meta: result.meta })
}

export async function getAdmin(req: Request, res: Response): Promise<void> {
  res.json({ data: await service.getPostAdmin(param(req, 'id')) })
}

export async function create(req: Request, res: Response): Promise<void> {
  const post = await service.createPost(req.user!.id, req.body)
  await recordAudit({ req, action: 'blog_post.created', entityType: 'BlogPost', entityId: post.id, after: post })
  res.status(201).json({ data: post })
}

export async function update(req: Request, res: Response): Promise<void> {
  const post = await service.updatePost(param(req, 'id'), req.body)
  await recordAudit({ req, action: 'blog_post.updated', entityType: 'BlogPost', entityId: post.id, after: post })
  res.json({ data: post })
}

export async function publish(req: Request, res: Response): Promise<void> {
  const post = await service.publishPost(param(req, 'id'))
  await recordAudit({ req, action: 'blog_post.published', entityType: 'BlogPost', entityId: post.id, after: post })
  res.json({ data: post })
}

export async function schedule(req: Request, res: Response): Promise<void> {
  const post = await service.schedulePost(param(req, 'id'), req.body.scheduledAt)
  await recordAudit({ req, action: 'blog_post.scheduled', entityType: 'BlogPost', entityId: post.id, after: post })
  res.json({ data: post })
}

export async function archive(req: Request, res: Response): Promise<void> {
  const post = await service.archivePost(param(req, 'id'))
  await recordAudit({ req, action: 'blog_post.archived', entityType: 'BlogPost', entityId: post.id, after: post })
  res.json({ data: post })
}

export async function revertToDraft(req: Request, res: Response): Promise<void> {
  const post = await service.revertToDraft(param(req, 'id'))
  await recordAudit({ req, action: 'blog_post.reverted_to_draft', entityType: 'BlogPost', entityId: post.id, after: post })
  res.json({ data: post })
}

export async function remove(req: Request, res: Response): Promise<void> {
  const id = param(req, 'id')
  await service.deletePost(id)
  await recordAudit({ req, action: 'blog_post.deleted', entityType: 'BlogPost', entityId: id })
  res.status(204).send()
}
