import type { Context, Config } from "@netlify/functions";

// Finds over-scheduled rotations for the staff Schedule Audit. Emails are opened
// as Gmail drafts in the browser (like the Revenue tab), not sent from here.

const BASE_ID = "appf6D9Nbhb5Wg43L";
const ROTATIONS_TABLE = "tbl6l75OeBLNzSp0i";
const SESSIONS_TABLE = "tblBC5TiAa8VEII9d";
const STUDENTS_TABLE = "tblesg1u5m2ec3cgg";
const STUDENT_NAME = "fldVi7kOcEg8BYmxv"; // "Last, First"
const STUDENT_PORTAL_LINK = "fldUjeEq8Cvl9Pew8"; // direct ?sid= portal link

const R = {
  label: "fldgP4DtHzPosEV5S", // course/placement label, not the student's name
  student: "fldL9I1HVkUxsFx89",
  hoursGoal: "fldMEhEDGeUZIjy42",
  priorHours: "fldQJOFnet3yenl9B",
  startDate: "fld9fGKesJEleHlKj",
  endDate: "fldwr35fEru3u8COS",
  email: "fldq1OTTqNh4XujN0",
  seatStatus: "fldyje5dpp4X3eeid",
  sessions: "fld2gJFT9jpN19oGz",
};
const S = {
  date: "fldWtu1BJ0gkmgZ8j",
  start: "fld7ysxgYdnx7YtJE",
  end: "fldQnm0rfl2eEWJE6",
  hours: "fldbQW9Ey797A0PHd",
  status: "fldALyzGgGJ6QO2Na",
  rotation: "fldNU8dYFasDntYGx",
  cancelRequested: "fldbR1ePMiNBHftnR",
};

const COUNTED = new Set(["Pending", "Approved", "Completed"]);

function json(body: any, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function fetchAll(token: string, table: string, fields: string[]): Promise<any[]> {
  let records: any[] = [];
  let offset: string | undefined;
  const fieldParams = fields.map((f) => `&fields%5B%5D=${f}`).join("");
  do {
    const url =
      `https://api.airtable.com/v0/${BASE_ID}/${table}?pageSize=100&returnFieldsByFieldId=true${fieldParams}` +
      (offset ? `&offset=${encodeURIComponent(offset)}` : "");
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || `Airtable read failed (${resp.status})`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records;
}

// Lookups/formulas can come back as arrays or {specialValue}; flatten to a plain value.
function plain(v: any): any {
  if (Array.isArray(v)) return v.length ? plain(v[0]) : undefined;
  if (v && typeof v === "object" && "name" in v) return v.name;
  return v;
}
function num(v: any): number {
  const n = Number(plain(v));
  return Number.isFinite(n) ? n : 0;
}
// Time fields are "HH:MM" text (24h); tolerate a duration in seconds too.
function fmtTime(v: any): string {
  const p = plain(v);
  let h: number, m: number;
  if (typeof p === "number") {
    h = Math.floor(p / 3600); m = Math.floor((p % 3600) / 60);
  } else {
    const match = /^(\d{1,2}):(\d{2})$/.exec((p || "").toString().trim());
    if (!match) return (p || "?").toString();
    h = Number(match[1]); m = Number(match[2]);
  }
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
function fmtDate(iso: string | undefined): string {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}
const round = (n: number) => Math.round(n * 100) / 100;

async function runAudit(token: string) {
  const [rotations, sessions, students] = await Promise.all([
    fetchAll(token, ROTATIONS_TABLE, Object.values(R)),
    fetchAll(token, SESSIONS_TABLE, Object.values(S)),
    fetchAll(token, STUDENTS_TABLE, [STUDENT_NAME, STUDENT_PORTAL_LINK]),
  ]);
  const sessionsById = new Map(sessions.map((s: any) => [s.id, s.fields]));
  const studentNameById = new Map(students.map((s: any) => [s.id, (s.fields[STUDENT_NAME] || "").toString()]));
  const portalLinkById = new Map(students.map((s: any) => [s.id, (s.fields[STUDENT_PORTAL_LINK] || "").toString().trim()]));

  const flagged: any[] = [];
  const outOfRangeOnly: any[] = [];
  for (const rot of rotations) {
    const f = rot.fields;
    if (plain(f[R.seatStatus]) === "Released") continue;

    const counted = ((f[R.sessions] || []) as string[])
      .map((id) => sessionsById.get(id))
      .filter((s: any) => s && COUNTED.has(plain(s[S.status])))
      .sort((a: any, b: any) => (a[S.date] || "").localeCompare(b[S.date] || "") || String(plain(a[S.start]) ?? "").localeCompare(String(plain(b[S.start]) ?? "")));

    const goal = num(f[R.hoursGoal]);
    const prior = num(f[R.priorHours]);
    const scheduledTotal = prior + counted.reduce((sum: number, s: any) => sum + num(s[S.hours]), 0);
    const hoursOver = scheduledTotal - goal;

    const describe = (s: any) => ({
      date: s[S.date] || "",
      label: `${fmtDate(s[S.date])} ${fmtTime(s[S.start])}–${fmtTime(s[S.end])}`,
      hours: num(s[S.hours]),
      status: plain(s[S.status]),
      cancelRequested: !!s[S.cancelRequested],
    });

    // The session that crosses the goal and every session after it are affected;
    // only Pending/Approved are listed since Completed ones already happened.
    const datesAffected: any[] = [];
    let running = prior;
    for (const s of counted) {
      running += num(s[S.hours]);
      if (running > goal && plain(s[S.status]) !== "Completed") datesAffected.push(describe(s));
    }

    const start = plain(f[R.startDate]);
    const end = plain(f[R.endDate]);
    const outOfRange = counted
      .filter((s: any) => s[S.date] && ((start && s[S.date] < start) || (end && s[S.date] > end)))
      .map(describe);

    // "Croom, Lori" -> "Lori Croom" for the greeting
    const rawName = studentNameById.get((f[R.student] || [])[0]) || "";
    const [last, first] = rawName.split(",").map((x: string) => x.trim());
    const row = {
      rotationId: rot.id,
      studentName: first ? `${first} ${last}` : rawName || "(no name)",
      placementLabel: plain(f[R.label]) || "",
      portalLink: portalLinkById.get((f[R.student] || [])[0]) || "",
      // Some students have "a@x.com; b@y.com" in one field — send to all of them
      email: (plain(f[R.email]) || "").toString().split(/[;,]/).map((e: string) => e.trim()).filter(Boolean).join(", "),
      startDate: start || "",
      endDate: end || "",
      seatStatus: plain(f[R.seatStatus]) || "",
      hoursGoal: round(goal),
      priorHours: round(prior),
      scheduledTotal: round(scheduledTotal),
      hoursOver: round(hoursOver),
      datesAffected,
      outOfRange,
    };
    if (hoursOver > 0) flagged.push(row);
    else if (outOfRange.length) outOfRangeOnly.push(row);
  }
  flagged.sort((a, b) => b.hoursOver - a.hoursOver);
  return { flagged, outOfRangeOnly, rotationsChecked: rotations.length };
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  let input: any;
  try {
    input = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const expectedPassword = Netlify.env.get("STAFF_PASSWORD");
  if (!expectedPassword) return json({ error: "Server is missing STAFF_PASSWORD." }, 500);
  if (!input.staffPassword || input.staffPassword !== expectedPassword) return json({ error: "Not authorized." }, 401);

  if (input.action === "audit") {
    const token = Netlify.env.get("AIRTABLE_TOKEN");
    if (!token) return json({ error: "Server is missing AIRTABLE_TOKEN." }, 500);
    try {
      return json({ ok: true, ...(await runAudit(token)) });
    } catch (err: any) {
      return json({ error: err?.message || "Audit failed" }, 502);
    }
  }

  return json({ error: 'action must be "audit"' }, 400);
};

export const config: Config = {
  path: "/.netlify/functions/schedule-audit",
};
