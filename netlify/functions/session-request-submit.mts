import type { Context, Config } from "@netlify/functions";

const SESSIONS_BASE_ID = "appXyJfoZAiVyyCwE";
const SESSIONS_TABLE_ID = "tblxwz24LDstMVrSI";
const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";

// A student can have multiple Students records (one per semester/quarter). When
// several match the same email, prefer whichever enrollment is actually current.
function statusRank(pipelineStatus: string): number {
  const s = pipelineStatus || "";
  if (s.includes("Active Rotation")) return 0;
  if (s.includes("Enrollment Completed")) return 1;
  return 2;
}

function calcHours(start: string, end: string): number {
  if (!start || !end) return 0;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = eh * 60 + em - (sh * 60 + sm);
  return mins > 0 ? Math.round((mins / 60) * 100) / 100 : 0;
}

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
  const university = (input.university || "").toString().trim();
  const totalHours = Number(input.totalHours) || 0;
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];

  if (!studentName || !studentEmail) {
    return new Response(JSON.stringify({ error: "Student name and email are required." }), { status: 400 });
  }

  const validRows = sessions.filter((r: any) => r && r.date && r.start && r.end);
  if (validRows.length === 0) {
    return new Response(JSON.stringify({ error: "Please provide at least one date, arrival time, and departure time." }), { status: 400 });
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  // Resolve the specific Students enrollment record for this email (best-effort —
  // if this fails or finds nothing, sessions still get created, just without the
  // link; lookupStudent() falls back to matching by email in that case).
  let studentRecordId: string | null = null;
  try {
    const lookupUrl = `https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}?filterByFormula=${encodeURIComponent(`LOWER({Email})="${studentEmail.toLowerCase()}"`)}`;
    const lookupResp = await fetch(lookupUrl, { headers: { Authorization: `Bearer ${token}` } });
    const lookupData: any = await lookupResp.json();
    if (lookupResp.ok) {
      const candidates = (lookupData?.records || []) as any[];
      candidates.sort((a, b) => {
        const byStatus = statusRank(a.fields?.["Pipeline Status"]) - statusRank(b.fields?.["Pipeline Status"]);
        if (byStatus !== 0) return byStatus;
        return (b.createdTime || "").localeCompare(a.createdTime || "");
      });
      if (candidates.length) studentRecordId = candidates[0].id;
    }
  } catch {
    // Non-fatal — proceed without the link.
  }

  // Strict allowlist, same spirit as intake-submit.mts — this is a public endpoint,
  // so status/approval fields are always forced server-side and never trusted from the client.
  const records = validRows.map((r: any) => {
    const date = (r.date || "").toString();
    const start = (r.start || "").toString();
    const end = (r.end || "").toString();
    const hrs = Number(r.hours) || calcHours(start, end);
    return {
      fields: {
        "Session Name": `${studentName} — ${fmtDate(date)}`,
        "Student Name": studentName,
        "Student Email": studentEmail,
        "University": university,
        "Session Date": date,
        "Start Time": start,
        "End Time": end,
        "Hours This Session": hrs,
        "Clinical Focus": (r.focus || "").toString().trim(),
        "Student Notes": (r.notes || "").toString().trim(),
        "Total Hours Required": totalHours,
        "Approval Status": "Pending",
        ...(studentRecordId ? { "Student ID (Airtable)": studentRecordId } : {}),
      },
    };
  });

  let created = 0;
  try {
    for (let i = 0; i < records.length; i += 10) {
      const batch = records.slice(i, i + 10);
      const resp = await fetch(`https://api.airtable.com/v0/${SESSIONS_BASE_ID}/${SESSIONS_TABLE_ID}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ records: batch, typecast: true }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return new Response(JSON.stringify({ error: data?.error?.message || "Airtable rejected the submission.", created }), { status: resp.status });
      }
      created += batch.length;
    }
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Proxy error", created }), { status: 502 });
  }

  return new Response(JSON.stringify({ ok: true, created }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/.netlify/functions/session-request-submit",
};
