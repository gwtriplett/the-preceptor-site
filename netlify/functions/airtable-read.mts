import type { Context, Config } from "@netlify/functions";

// Only this base can ever be touched through this function —
// prevents this proxy from being used to reach any other Airtable data.
const ALLOWED_BASES: Record<string, true> = {
  "appf6D9Nbhb5Wg43L": true, // Student Management (also houses Sessions, co-located)
};

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

  const { staffPassword, base, table, path } = payload || {};

  // Staff only — same staff password check as airtable-write. The student
  // portal reads through student-read instead, which only ever returns the
  // signed-in student's own records.
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

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  const url = `https://api.airtable.com/v0/${base}/${table}${path || ""}`;

  try {
    const airtableResp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
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
  path: "/.netlify/functions/airtable-read",
};
