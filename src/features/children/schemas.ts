import { z } from "zod";

/**
 * Child profile input — Tech Spec §7, Brief §46.
 *
 * Minimal by design. WLA does not require faces, public full names, school
 * names, identifiable home information or unnecessary sensitive data.
 *
 * `displayName` is what the child is called in the family — a first name or a
 * nickname. Nothing asks for a surname.
 */

const CURRENT_YEAR = new Date().getFullYear();

export const childProfileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Enter a name.")
    .regex(/^\S+$/u, "Enter one first name or nickname only.")
    .max(40, "That name is a little long."),
  /**
   * Year of birth, not a full date — enough to show an age band without
   * storing a birthday. Optional: OPEN-05 has not confirmed whether age gates
   * anything, so nothing depends on it yet.
   */
  birthYear: z
    .union([
      z.literal(""),
      z.coerce
        .number()
        .int()
        .min(CURRENT_YEAR - 18, "That year seems too long ago.")
        .max(CURRENT_YEAR, "That year is in the future."),
    ])
    .optional(),
});

export type ChildProfileInput = z.infer<typeof childProfileSchema>;
