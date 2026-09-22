import type { Context, Config } from "@netlify/functions";

const SESSIONS_BASE_ID = "appf6D9Nbhb5Wg43L";
const SESSIONS_TABLE_ID = "tblBC5TiAa8VEII9d";
const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";
const ROTATIONS_TABLE_ID = "tbl6l75OeBLNzSp0i";

// Picks which of a student's Rotations a new session request belongs to —
// the same rule the student portal uses to choose which rotation to show in
// its header: prefer one whose requested dates span today, then an Active
// Rotation status, then whichever Rotation is most recently created.
function pickCurrentRotation(rotations: any[]): any | null {
  if (!rotations.length) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const inRange = (r: any) => {
    const start = r.fields?.["Requested Start Date"];
    const end = r.fields?.["Requested End Date"];
    if (!start || !end) return false;
    const s = new Date(start + "T00:00:00");
    const e = new Date(end + "T23:59:59");
    return today >= s && today <= e;
  };
  const statusRank = (r: any) => {
    const s = r.fields?.["Pipeline Status"] || "";
    if (s.includes("Active Rotation")) return 0;
    if (s.includes("Completed")) return 2;
    return 1;
  };
  const sorted = [...rotations].sort((a, b) => {
    const byRange = (inRange(b) ? 1 : 0) - (inRange(a) ? 1 : 0);
    if (byRange !== 0) return byRange;
    const byStatus = statusRank(a) - statusRank(b);
    if (byStatus !== 0) return byStatus;
    return (b.createdTime || "").localeCompare(a.createdTime || "");
  });
  return sorted[0];
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

  // Resolve the Student record for this email, then the Rotation (within
  // that student's linked Rotations) this request belongs to. Students no
  // longer repeats per semester — one Student record covers every term, and
  // term-specific status/hours/dates live on Rotations — so lookup is by
  // email first, Rotation second. Best-effort: if this fails or finds
  // nothing, sessions still get created, just without the link(s);
  // lookupStudent() on the portal falls back to matching by email.
  let studentRecordId: string | null = null;
  let rotationRecordId: string | null = null;
  let rotationHoursGoal: number | null = null;
  try {
    const lookupUrl = `https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}?filterByFormula=${encodeURIComponent(`LOWER({Email})="${studentEmail.toLowerCase()}"`)}`;
    const lookupResp = await fetch(lookupUrl, { headers: { Authorization: `Bearer ${token}` } });
    const lookupData: any = await lookupResp.json();
    if (lookupResp.ok) {
      const candidates = (lookupData?.records || []) as any[];
      // Legacy safety: if more than one Students row somehow matches this
      // email, prefer whichever was created most recently.
      candidates.sort((a, b) => (b.createdTime || "").localeCompare(a.createdTime || ""));
      const student = candidates[0];
      if (student) {
        studentRecordId = student.id;
        const rotationIds: string[] = student.fields?.["Rotations"] || [];
        if (rotationIds.length) {
          const rotFormula = `OR(${rotationIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`;
          const rotUrl = `https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${ROTATIONS_TABLE_ID}?filterByFormula=${encodeURIComponent(rotFormula)}`;
          const rotResp = await fetch(rotUrl, { headers: { Authorization: `Bearer ${token}` } });
          const rotData: any = await rotResp.json();
          if (rotResp.ok) {
            const rotation = pickCurrentRotation(rotData?.records || []);
            if (rotation) {
              rotationRecordId = rotation.id;
              if (typeof rotation.fields?.["Hours Goal"] === "number") {
                rotationHoursGoal = rotation.fields["Hours Goal"];
              }
            }
          }
        }
      }
    }
  } catch {
    // Non-fatal — proceed without the link(s).
  }

  // Reject if this student already has a session on any of the requested dates —
  // prevents accidental duplicate submissions for the same day.
  try {
    const dates = [...new Set(validRows.map((r: any) => (r.date || "").toString()))];
    const dateClauses = dates.map((d) => `DATESTR({Session Date})="${d}"`).join(",");
    const dupFormula = `AND(LOWER({Student Email})="${studentEmail.toLowerCase()}", OR(${dateClauses}))`;
    const dupUrl = `https://api.airtable.com/v0/${SESSIONS_BASE_ID}/${SESSIONS_TABLE_ID}?filterByFormula=${encodeURIComponent(dupFormula)}`;
    const dupResp = await fetch(dupUrl, { headers: { Authorization: `Bearer ${token}` } });
    const dupData: any = await dupResp.json();
    if (dupResp.ok && (dupData?.records || []).length > 0) {
      const dupDate = dupData.records[0]?.fields?.["Session Date"];
      return new Response(
        JSON.stringify({
          error: `You already have a request for ${fmtDate(dupDate) || "that date"} — check your pending requests.`,
        }),
        { status: 409 }
      );
    }
  } catch {
    // Non-fatal — if the duplicate check itself fails, fall through and allow submission.
  }

  // The Rotation's own Hours Goal is the authoritative total when we found
  // one — falls back to the client-supplied value only if no Rotation matched
  // (e.g. a student without any Rotation on file yet).
  const effectiveTotalHours = rotationHoursGoal != null ? rotationHoursGoal : totalHours;

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
        "Total Hours Required": effectiveTotalHours,
        "Approval Status": "Pending",
        ...(studentRecordId ? { "Student ID (Airtable)": studentRecordId } : {}),
        ...(rotationRecordId ? { "Rotation": [rotationRecordId] } : {}),
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
