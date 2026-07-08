import type { Context, Config } from "@netlify/functions";

const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";

function last4(phone: string) {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "0");
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

  const firstName = (input.firstName || "").toString().trim();
  const lastName = (input.lastName || "").toString().trim();
  const email = (input.email || "").toString().trim();
  const phone = (input.phone || "").toString().trim();

  if (!firstName || !lastName || !email || !phone) {
    return new Response(JSON.stringify({ error: "First name, last name, email, and phone are required." }), { status: 400 });
  }

  const startDate = (input.startDate || "").toString();
  const yy = startDate
    ? String(new Date(startDate + "T00:00:00").getFullYear()).slice(-2)
    : String(new Date().getFullYear()).slice(-2);
  const studentId = `${yy}-${last4(phone)}`;
  const studentName = `${lastName}, ${firstName}`;

  // Strict allowlist — only these fields can ever be written by this public endpoint.
  // Status/source/timestamp fields are set here server-side, never trusted from the client.
  const fields: Record<string, any> = {
    "Student Name": studentName,
    "First Name": firstName,
    "Last Name": lastName,
    "Student ID": studentId,
    "Email": email,
    "Phone Number": phone,
    "Current Address": (input.address || "").toString().trim(),
    "University / College": (input.university || "").toString().trim(),
    "Degree / Program": (input.program || "").toString().trim(),
    "Current Year / Semester": (input.yearSemester || "").toString().trim(),
    "Total Hours Required": Number(input.hoursRequired) || null,
    "Requested Start Date": startDate || null,
    "Requested End Date": (input.endDate || "").toString() || null,
    "Additional Period Requested?": input.additionalPeriod ? "Yes" : "No",
    "University Supervisor Name": (input.supervisorName || "").toString().trim(),
    "University Supervisor Email": (input.supervisorEmail || "").toString().trim(),
    "Resume Link": (input.resumeLink || "").toString().trim(),
    "School Handbook Link": (input.handbookLink || "").toString().trim(),
    "Clinical Focus / Objectives": (input.clinicalFocus || "").toString().trim(),
    "Special Notes": (input.specialNotes || "").toString().trim(),
    "Intake Source": "Website Form",
    "Pipeline Status": "🟡 Inquiry Received",
    "Admission Status": ["Application Received"],
    "Intake Timestamp": new Date().toISOString(),
  };
  if (input.additionalPeriod) {
    fields["Additional Period - Start Date"] = (input.addStartDate || "").toString() || null;
    fields["Additional Period - End Date"] = (input.addEndDate || "").toString() || null;
  }

  // Strip empty/null so Airtable doesn't choke on blank optional fields
  Object.keys(fields).forEach((k) => {
    if (fields[k] === "" || fields[k] === null) delete fields[k];
  });

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  try {
    const resp = await fetch(`https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: data?.error?.message || "Airtable rejected the submission." }), { status: resp.status });
    }
    return new Response(JSON.stringify({ ok: true, studentId }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Proxy error" }), { status: 502 });
  }
};

export const config: Config = {
  path: "/.netlify/functions/intake-submit",
};
