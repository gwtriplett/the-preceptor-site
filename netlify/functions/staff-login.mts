import type { Context, Config } from "@netlify/functions";
import { checkStaffPassword, isStaffPasswordConfigured, issueStaffPass } from "./lib/staff-auth.mts";

// Checks the staff password on the server and, if it's right, hands back a
// signed pass the page uses for every staff request. The password itself
// never needs to live in the page.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
  }
  if (!isStaffPasswordConfigured()) {
    return new Response(JSON.stringify({ error: "Server is missing STAFF_PASSWORD. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  if (!checkStaffPassword(payload?.password)) {
    // Small fixed delay to slow down password guessing.
    await new Promise((r) => setTimeout(r, 800));
    return new Response(JSON.stringify({ error: "Incorrect password." }), { status: 401 });
  }

  return new Response(JSON.stringify({ ok: true, ...issueStaffPass() }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/.netlify/functions/staff-login",
};
