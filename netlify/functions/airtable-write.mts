import type { Context, Config } from "@netlify/functions";

const ALLOWED_BASES: Record<string, true> = {
  "appXyJfoZAiVyyCwE": true, // Sessions
  "appf6D9Nbhb5Wg43L": true, // Student Management
};
const ALLOWED_METHODS: Record<string, true> = { GET: true, POST: true, PATCH: true };

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const { staffPassword, base, table, method = "GET", path, body } = payload || {};

  // Gate: only requests that include the correct staff password get write access.
  // This is the same password staff use to log into the scheduler.
  const expectedPassword = Netlify.env.get("STAFF_PASSWORD");
  if (!expectedPassword) {
    return new Response(JSON.stringify({ error: "Server is missing STAFF_PASSWORD. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }
  if (!staffPassword || staffPassword !== expectedPassword) {
    return new Response(JSON.stringify({ error: "Not authorized." }), { status: 401 });
  }

  if (!base || !ALLOWED_BASES[base]) {
    return new Response(JSON.stringify({ error: "Base not allowed" }), { status: 403 });
  }
  if (!table || typeof table !== "string") {
    return new Response(JSON.stringify({ error: "Table is required" }), { status: 400 });
  }
  if (!ALLOWED_METHODS[method]) {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  const url = `https://api.airtable.com/v0/${base}/${table}${path || ""}`;

  try {
    const airtableResp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await airtableResp.json();
    return new Response(JSON.stringify(data), {
      status: airtableResp.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Proxy error" }), { status: 502 });
  }
};

export const config: Config = {
  path: "/.netlify/functions/airtable-write",
};
