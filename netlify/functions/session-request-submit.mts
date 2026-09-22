import type { Context, Config } from "@netlify/functions";

const SESSIONS_BASE_ID = "appf6D9Nbhb5Wg43L";
const SESSIONS_TABLE_ID = "tblBC5TiAa8VEII9d";
const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";
const ROTATIONS_TABLE_ID = "tbl6l75OeBLNzSp0i";

// A rotation is only open for new session requests once it's actually paid
// for and underway — matches the Rotations table's Pipeline Status choices.
// Anything else means payment isn't complete yet (Inquiry Received,
// Contract Sent, Awaiting Payment) or the clinical period is over/void
// (Completed, Withdrawn, Terminated, or a bare "New Application").
const SCHEDULABLE_STATUSES = new Set(["Enrollment Completed", "3rd Party Preceptor Enrollment", "🟢 Active Rotation"]);
function isSchedulable(rotation: any): boolean {
  return SCHEDULABLE_STATUSES.has(rotation?.fields?.["Pipeline Status"] || "");
}

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
  // Which of the student's (possibly several) rotations this batch belongs
  // to. The portal now lets the student pick this explicitly when they have
  // more than one open rotation — required, not just a hint, once we've
  // resolved the student below.
  const requestedRotationId = (input.rotationId || "").toString().trim() || null;

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
  // email first, Rotation second.
  let studentRecordId: string | null = null;
  let rotationRecordId: string | null = null;
  let rotationHoursGoal: number | null = null;
  let rotation: any = null;
  let rotationLookupFailed = false;
  let studentHasAnyRotations = false;
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
        studentHasAnyRotations = rotationIds.length > 0;
        if (rotationIds.length) {
          const rotFormula = `OR(${rotationIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`;
          const rotUrl = `https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${ROTATIONS_TABLE_ID}?filterByFormula=${encodeURIComponent(rotFormula)}`;
          const rotResp = await fetch(rotUrl, { headers: { Authorization: `Bearer ${token}` } });
          const rotData: any = await rotResp.json();
          if (rotResp.ok) {
            const studentRotations = (rotData?.records || []) as any[];
            // A rotation this student paid for and is (or was) actively in —
            // never a rotation still pending payment, or one that's already
            // finished/withdrawn/terminated. Checked here regardless of how
            // the rotation was chosen, since the client's own filtering is
            // only a convenience, never the enforcement.
            const schedulable = studentRotations.filter(isSchedulable);

            if (requestedRotationId) {
              // The student explicitly picked one of their rotations (the
              // usual path once they have more than one paid rotation on
              // file) — it must be both theirs and currently schedulable.
              const picked = studentRotations.find((r) => r.id === requestedRotationId);
              if (picked && isSchedulable(picked)) {
                rotation = picked;
              }
              // If picked-but-not-schedulable, or not found among their own
              // rotations at all, `rotation` stays null and the generic
              // "no schedulable rotation" response below explains why.
            } else {
              // No explicit pick (older client, or the student has exactly
              // one option) — fall back to the best-guess "current" one,
              // chosen only from rotations that are actually schedulable.
              rotation = pickCurrentRotation(schedulable);
            }

            if (rotation) {
              rotationRecordId = rotation.id;
              if (typeof rotation.fields?.["Hours Goal"] === "number") {
                rotationHoursGoal = rotation.fields["Hours Goal"];
              }
            }
          } else {
            rotationLookupFailed = true;
          }
        }
      }
    } else {
      rotationLookupFailed = true;
    }
  } catch {
    rotationLookupFailed = true;
  }

  // A session request must fall within the timeframe of a specific Rotation
  // the student actually paid for and is (or was) active in, and can't
  // schedule past 110% of that Rotation's hours. Without one resolved,
  // there's no timeframe or cap to check against, so we can't let
  // scheduling through — except when the *lookup itself* failed (a
  // transient read error), where we'd rather not block a legitimate
  // request over our own flakiness.
  if (!rotationRecordId || !rotation) {
    if (rotationLookupFailed) {
      return new Response(
        JSON.stringify({ error: "We couldn't verify your rotation just now. Please try again in a moment." }),
        { status: 502 }
      );
    }
    const message = requestedRotationId
      ? "That rotation isn't open for scheduling right now — its payment may still be pending, or its clinical period has ended. Contact your coordinator if this seems wrong."
      : studentHasAnyRotations
      ? "None of your rotations are currently open for scheduling — payment may still be pending, or the clinical period has ended. Contact your coordinator."
      : "We couldn't find an active rotation on file for you. Please contact your coordinator before scheduling sessions.";
    return new Response(JSON.stringify({ error: message }), { status: 409 });
  }

  // Both checks below always run — a batch can fail either or both, and the
  // student needs to see the whole picture in one response so they can fix
  // everything before resubmitting, rather than discovering problems one at
  // a time across several round trips.
  const rotationStart = (rotation.fields?.["Requested Start Date"] || "").toString();
  const rotationEnd = (rotation.fields?.["Requested End Date"] || "").toString();
  const outOfRangeDates = rotationStart && rotationEnd
    ? [...new Set(
        validRows
          .map((r: any) => (r.date || "").toString())
          .filter((d: string) => d < rotationStart || d > rotationEnd)
      )]
    : [];

  let capExceeded = false;
  let hoursCap: number | null = null;
  let hoursUsed = 0;
  let hoursRequested = 0;
  if (rotationHoursGoal != null) {
    hoursCap = Math.round(rotationHoursGoal * 1.1 * 100) / 100;
    hoursRequested = validRows.reduce(
      (sum: number, r: any) => sum + (Number(r.hours) || calcHours((r.start || "").toString(), (r.end || "").toString())),
      0
    );
    try {
      const studentSessionsUrl = `https://api.airtable.com/v0/${SESSIONS_BASE_ID}/${SESSIONS_TABLE_ID}?filterByFormula=${encodeURIComponent(`{Student ID (Airtable)}="${studentRecordId}"`)}`;
      const studentSessionsResp = await fetch(studentSessionsUrl, { headers: { Authorization: `Bearer ${token}` } });
      const studentSessionsData: any = await studentSessionsResp.json();
      if (studentSessionsResp.ok) {
        hoursUsed = ((studentSessionsData?.records || []) as any[])
          .filter((r) => (r.fields?.["Rotation"] || []).includes(rotationRecordId) && r.fields?.["Approval Status"] !== "Denied")
          .reduce((sum, r) => sum + (Number(r.fields?.["Hours This Session"]) || 0), 0);
        capExceeded = hoursUsed + hoursRequested > hoursCap;
      }
      // If the check itself fails, fall through as not-exceeded — we'd
      // rather not block a legitimate request over a transient read error.
    } catch {
      // Non-fatal — same reasoning as above.
    }
  }

  if (outOfRangeDates.length || capExceeded) {
    const hoursRemaining = hoursCap != null ? Math.max(0, Math.round((hoursCap - hoursUsed) * 100) / 100) : null;
    const parts: string[] = [];
    if (outOfRangeDates.length) {
      parts.push(
        `${outOfRangeDates.map((d) => fmtDate(d)).join(", ")} ${outOfRangeDates.length === 1 ? "falls" : "fall"} outside your requested rotation timeframe (${fmtDate(rotationStart)} – ${fmtDate(rotationEnd)}).`
      );
    }
    if (capExceeded) {
      parts.push(
        `This batch would put you over your scheduled hours for this rotation — you paid for ${rotationHoursGoal} hours (up to ${hoursCap} with the 10% buffer) and ${hoursRemaining} hour(s) are still available.`
      );
    }
    parts.push("Remove or change the affected date(s) and resubmit.");
    return new Response(
      JSON.stringify({
        error: parts.join(" "),
        outOfRangeDates,
        rotationStart,
        rotationEnd,
        capExceeded,
        hoursGoal: rotationHoursGoal,
        hoursCap,
        hoursUsed,
        hoursRequested,
        hoursRemaining,
      }),
      { status: 422 }
    );
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
