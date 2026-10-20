// Staff sign-in passes. Not a function itself — bundled into whichever
// function imports it.
//
// The staff password (STAFF_PASSWORD env var) is only ever checked here on
// the server. A correct password gets a signed pass that expires after
// PASS_TTL_MS; the page sends that pass (never the password) on every staff
// request. The signing key is derived from STAFF_PASSWORD, so changing the
// password in Netlify immediately invalidates every pass already handed out.

import { createHmac, timingSafeEqual } from "node:crypto";

const PASS_TTL_MS = 12 * 60 * 60 * 1000;

function staffPassword(): string {
  return Netlify.env.get("STAFF_PASSWORD") || "";
}

function signingKey(pw: string): Buffer {
  return createHmac("sha256", "tps-staff-pass-v1").update(pw).digest();
}

function sign(pw: string, payload: string): string {
  return createHmac("sha256", signingKey(pw)).update(payload).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function isStaffPasswordConfigured(): boolean {
  return !!staffPassword();
}

export function checkStaffPassword(candidate: unknown): boolean {
  const pw = staffPassword();
  return !!pw && typeof candidate === "string" && safeEqual(candidate, pw);
}

export function issueStaffPass(): { pass: string; expiresAt: number } {
  const expiresAt = Date.now() + PASS_TTL_MS;
  const payload = `v1.${expiresAt}`;
  return { pass: `${payload}.${sign(staffPassword(), payload)}`, expiresAt };
}

export function verifyStaffPass(pass: unknown): boolean {
  const pw = staffPassword();
  if (!pw || typeof pass !== "string") return false;
  const parts = pass.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const expiresAt = Number(parts[1]);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  return safeEqual(parts[2], sign(pw, `${parts[0]}.${parts[1]}`));
}

export function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "Not authorized. Please sign in again." }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
