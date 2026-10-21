// Works out which Airtable records belong to a student, from the email
// address or Student ID they signed in with. Not a function itself —
// bundled into whichever function imports it.
//
// Students sign in with just an email or Student ID (no password), so this
// doesn't prove who someone is — it limits each request to the data of the
// one student named, so nobody can pull every student's records at once.

export const BASE_ID = "appf6D9Nbhb5Wg43L";
export const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";
export const ROTATIONS_TABLE_ID = "tbl6l75OeBLNzSp0i";
export const SESSIONS_TABLE_ID = "tblBC5TiAa8VEII9d";

export type StudentIdentity = {
  emails: Set<string>;       // lowercased
  studentIds: Set<string>;   // Students record IDs
  rotationIds: Set<string>;  // Rotations linked from those Students records
};

const STUDENT_ID_RE = /^\d{2}-\d{4}$/;

// Strip anything that could break out of a quoted Airtable formula string.
function formulaSafe(v: string): string {
  return v.replace(/["\\]/g, "").trim().toLowerCase();
}

export function splitEmails(v: unknown): string[] {
  return ([] as unknown[]).concat(v ?? [])
    .flatMap((x) => String(x).split(/[;,]/))
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x.includes("@"));
}

async function listAll(token: string, table: string, formula: string): Promise<any[]> {
  const out: any[] = [];
  let offset = "";
  do {
    const url = `https://api.airtable.com/v0/${BASE_ID}/${table}?pageSize=100&filterByFormula=${encodeURIComponent(formula)}${offset ? `&offset=${offset}` : ""}`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || "Airtable lookup failed");
    out.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return out;
}

// Returns null when the value isn't a usable email or Student ID.
export async function resolveStudent(token: string, raw: unknown): Promise<StudentIdentity | null> {
  const val = formulaSafe(String(raw ?? ""));
  if (!val || val.length > 200) return null;

  const emails = new Set<string>();
  let byId: any[] = [];
  if (STUDENT_ID_RE.test(val)) {
    byId = await listAll(token, STUDENTS_TABLE_ID, `LOWER({Student ID})="${val}"`);
    byId.forEach((r) => splitEmails(r.fields?.["Email"]).forEach((e) => emails.add(e)));
    if (!emails.size) {
      // A Student ID with no email on file still owns its own record(s).
      return {
        emails,
        studentIds: new Set(byId.map((r) => r.id)),
        rotationIds: new Set(byId.flatMap((r) => r.fields?.["Rotations"] || [])),
      };
    }
  } else if (val.includes("@")) {
    emails.add(val);
  } else {
    return null;
  }

  // Every Students record under those emails (a student can have several).
  // The Email field can hold several addresses ("a@x.edu; b@y.com"), so the
  // formula does a loose substring match and the exact per-address check
  // happens here, so "ann@x.com" doesn't also claim "joann@x.com".
  const formula = `OR(${[...emails].map((e) => `FIND("${formulaSafe(e)}",LOWER({Email}))`).join(",")})`;
  const records = [
    ...byId,
    ...(await listAll(token, STUDENTS_TABLE_ID, formula))
      .filter((r) => splitEmails(r.fields?.["Email"]).some((e) => emails.has(e))),
  ];
  return {
    emails,
    studentIds: new Set(records.map((r) => r.id)),
    rotationIds: new Set(records.flatMap((r) => r.fields?.["Rotations"] || [])),
  };
}

export function ownsRotation(id: StudentIdentity, rotationId: string, rotationFields?: any): boolean {
  if (id.rotationIds.has(rotationId)) return true;
  return ((rotationFields?.["Student"] || []) as string[]).some((s) => id.studentIds.has(s));
}

export function ownsSession(id: StudentIdentity, f: any): boolean {
  if (splitEmails(f?.["Student Email"]).some((e) => id.emails.has(e))) return true;
  if (id.studentIds.has(String(f?.["Student ID (Airtable)"] || ""))) return true;
  return ((f?.["Rotation"] || []) as string[]).some((r) => id.rotationIds.has(r));
}
