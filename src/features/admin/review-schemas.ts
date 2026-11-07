import { z } from "zod";

export const reviewStatusChangeSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["pending", "published", "declined"]),
});

export const reviewDetailsSchema = z.object({
  id: z.string().uuid(),
  admin_notes: z.string().trim().max(2000),
  verified: z
    .union([z.literal("on"), z.null()])
    .transform((value) => value === "on"),
  featured: z
    .union([z.literal("on"), z.null()])
    .transform((value) => value === "on"),
  featured_order: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(9999)),
});
