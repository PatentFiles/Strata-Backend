import type { Request } from "express";

// Replaced into the test bundle only; the application keeps the real Clerk SDK.
export function getAuth(req: Request) {
  return { userId: req.header("x-test-user-id") ?? null };
}