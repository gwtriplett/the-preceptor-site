import type { Context, Config } from "@netlify/functions";

// Only these two bases can ever be touched through this function —
// prevents this proxy from being used to reach any other Airtable data.
const ALLOWED_BASES: Record<string, true> = {
  "appXyJfoZAiVyyCwE": true, // Sessions
  "appf6D9Nbhb5Wg43L": true, // Student Management
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

  const { base, table, path } = payload || {};

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
