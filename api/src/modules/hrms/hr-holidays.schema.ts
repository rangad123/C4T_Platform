import { z } from 'zod'

export const createHolidaySchema = z.object({
  date: z.coerce.date(),
  name: z.string().trim().min(1).max(160),
})

export const yearQuery = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
})

export const holidayIdParam = z.object({ id: z.string().cuid() })

export type CreateHolidayInput = z.infer<typeof createHolidaySchema>
export type YearQuery = z.infer<typeof yearQuery>
