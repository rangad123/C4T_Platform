import { z } from 'zod'

export const createTemplateSchema = z.object({
  /** Defaults to the uploaded file's own name when omitted — see the service. */
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).optional(),
  fileId: z.string().cuid(),
})

export const templateIdParam = z.object({ id: z.string().cuid() })

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>
