import type { Context, Config } from "@netlify/functions";

const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const MESSAGES_TABLE_ID = "tbltq7GwNZaR4mmUY";

// Public endpoint — the student portal's "Message Coordinator" tab (and the
// "Request to cancel session" button) POST here so every message lands in
// the Coordinator Messages Airtable table, not just an email. Status is
// always forced to "New" server-side, same spirit as the other public
// endpoints — nothing from the client is trusted for that.

function fmtDate(d: string): string {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405 });
  }

  let input: any;
  try {
    input = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const studentName = (input.studentName || "").toString().trim();
  const studentEmail = (input.studentEmail || "").toString().trim();
  const studentRecordId = (input.studentRecordId || "").toString().trim();
  const subject = (input.subject || "").toString().trim();
  const message = (input.message || "").toString().trim();

  if (!studentName || !subject || !message) {
    return new Response(JSON.stringify({ error: "Student name, subject, and message are required." }), { status: 400 });
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  const fields: Record<string, any> = {
    "Message Name": `${studentName} — ${subject} — ${fmtDate(new Date().toISOString().split("T")[0])}`,
    "Student Name": studentName,
    "Student Email": studentEmail,
    "Subject": subject,
    "Message": message,
    "Status": "New",
    // Only link a real Students record ID — never trust an arbitrary string
    // from the client as a linked-record ID without validating its shape.
    ...(/^rec[A-Za-z0-9]{14}$/.test(studentRecordId) ? { "Student": [studentRecordId] } : {}),
  };

  try {
    const resp = await fetch(`https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${MESSAGES_TABLE_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: data?.error?.message || "Airtable rejected the message." }), { status: resp.status });
    }
    return new Response(JSON.stringify({ ok: true, messageId: data?.records?.[0]?.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Proxy error" }), { status: 502 });
  }
};

export const config: Config = {
  path: "/.netlify/functions/message-submit",
};
