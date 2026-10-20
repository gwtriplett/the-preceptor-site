import type { Context, Config } from "@netlify/functions";
import {
  BASE_ID, STUDENTS_TABLE_ID, ROTATIONS_TABLE_ID, SESSIONS_TABLE_ID,
  resolveStudent, ownsRotation, ownsSession, splitEmails, type StudentIdentity,
} from "./lib/student-identity.mts";

// Read access for the student portal. The page sends the same table + query
// it would send staff-side, plus the email / Student ID the student signed
// in with. The query runs as-is, then every record that isn't that
// student's is removed before anything is returned:
//   - Students, Rotations, Coordinator Messages: only the student's own rows
//   - Sessions: the student's own rows in full; everyone else's reduced to
//     an anonymous "Booked" time slot (the calendar needs these to show
//     which days are full)
//   - Settings: only the capacity limit and blackout dates
// Any other table is refused.

const SETTINGS_TABLE_ID = "tblWrhu0Macqnjt3H";
const MESSAGES_TABLE_ID = "tbltq7GwNZaR4mmUY";
const SETTINGS_FIELDS = ["Daily Capacity Limit", "Blackout Dates"];
const SLOT_FIELDS = ["Session Date", "Start Time", "End Time", "Approval Status", "Hours This Session"];

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function pick(fields: any, keys: string[]) {
  const out: Record<string, any> = {};
  keys.forEach((k) => { if (fields?.[k] !== undefined) out[k] = fields[k]; });
  return out;
}

// Returns the record to send back (possibly reduced), or null to drop it.
function scope(table: string, rec: any, id: StudentIdentity): any | null {
  const f = rec.fields || {};
  switch (table) {
    case STUDENTS_TABLE_ID:
      return id.studentIds.has(rec.id) ? rec : null;
    case ROTATIONS_TABLE_ID:
      return ownsRotation(id, rec.id, f) ? rec : null;
    case MESSAGES_TABLE_ID:
      return splitEmails(f["Student Email"]).some((e) => id.emails.has(e)) ? rec : null;
    case SESSIONS_TABLE_ID:
      return ownsSession(id, f)
        ? rec
        : { id: rec.id, createdTime: rec.createdTime, fields: { ...pick(f, SLOT_FIELDS), "Student Name": "Booked" } };
    case SETTINGS_TABLE_ID:
      return { id: rec.id, createdTime: rec.createdTime, fields: pick(f, SETTINGS_FIELDS) };
    default:
      return null;
  }
}

const ALLOWED_TABLES = new Set([STUDENTS_TABLE_ID, ROTATIONS_TABLE_ID, SESSIONS_TABLE_ID, SETTINGS_TABLE_ID, MESSAGES_TABLE_ID]);

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const { base, table, student } = payload || {};
  const rawPath = typeof payload?.path === "string" ? payload.path : "";

  if (base !== BASE_ID) return json({ error: "Base not allowed" }, 403);
  if (!ALLOWED_TABLES.has(table)) return json({ error: "Table not allowed" }, 403);

  // Only a query string or a single record ID. Options that would change
  // the shape of the response (field IDs instead of names, string cell
  // format) are dropped so the ownership checks below always see field names.
  let path = "";
  let singleRecord = false;
  if (/^\/rec[A-Za-z0-9]{14}$/.test(rawPath)) {
    path = rawPath;
    singleRecord = true;
  } else if (rawPath === "" || rawPath.startsWith("?")) {
    const params = new URLSearchParams(rawPath.slice(1));
    ["returnFieldsByFieldId", "cellFormat", "timeZone", "userLocale"].forEach((k) => params.delete(k));
    const qs = params.toString();
    path = qs ? `?${qs}` : "";
  } else {
    return json({ error: "Invalid path" }, 400);
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) return json({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }, 500);

  let identity: StudentIdentity | null = null;
  if (table !== SETTINGS_TABLE_ID) {
    try {
      identity = await resolveStudent(token, student);
    } catch (err: any) {
      return json({ error: err?.message || "Could not look up student" }, 502);
    }
    if (!identity) return json({ error: "Enter a valid email address or Student ID." }, 400);
  }
  const id = identity || { emails: new Set<string>(), studentIds: new Set<string>(), rotationIds: new Set<string>() };

  try {
    const resp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${table}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data: any = await resp.json();
    if (!resp.ok) return json({ error: data?.error?.message || "Airtable error" }, resp.status);

    if (singleRecord) {
      const rec = scope(table, data, id);
      return rec ? json(rec) : json({ error: "Not found" }, 404);
    }
    const records = (data.records || []).map((r: any) => scope(table, r, id)).filter(Boolean);
    return json({ records, ...(data.offset ? { offset: data.offset } : {}) });
  } catch (err: any) {
    return json({ error: err?.message || "Proxy error" }, 502);
  }
};

export const config: Config = {
  path: "/.netlify/functions/student-read",
};
