import { z } from "zod";

export const SignupInput = z.object({
  email: z.string().email(),
  password: z.string().min(12).max(256),
});
export type SignupInput = z.infer<typeof SignupInput>;

export const LoginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof LoginInput>;

export const SessionUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
});
export type SessionUser = z.infer<typeof SessionUser>;
