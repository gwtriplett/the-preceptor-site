import type { Context, Config } from "@netlify/functions";

const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";
const ROTATIONS_TABLE_ID = "tbl6l75OeBLNzSp0i";

// Public endpoint — a logged-in student on the portal uses this to request a
// NEW rotation period (a new semester/course) without re-submitting the whole
// intake form. Unlike intake-submit.mts, this never creates a Student record:
// the student must already exist, identified by the Airtable record ID the
// portal already resolved via lookupStudent(). Status/pipeline fields are
// always forced server-side, same spirit as intake-submit.mts and
// session-request-submit.mts — nothing from the client is trusted for those.

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

  const studentRecordId = (input.studentRecordId || "").toString().trim();
  const studentEmail = (input.studentEmail || "").toString().trim();
  const courseName = (input.courseName || "").toString().trim();
  const semesterQuarter = (input.semesterQuarter || "").toString().trim();
  const university = (input.university || "").toString().trim();
  const startDate = (input.startDate || "").toString().trim();
  const endDate = (input.endDate || "").toString().trim();
  const hoursGoal = Number(input.hoursGoal) || null;
  const clinicalFocus = (input.clinicalFocus || "").toString().trim();
  const specialNotes = (input.specialNotes || "").toString().trim();

  if (!/^rec[A-Za-z0-9]{14}$/.test(studentRecordId)) {
    return new Response(JSON.stringify({ error: "Could not identify your student profile — please look yourself up again and retry." }), { status: 400 });
  }
  if (!courseName) {
    return new Response(JSON.stringify({ error: "Course name is required." }), { status: 400 });
  }
  if (!semesterQuarter) {
    return new Response(JSON.stringify({ error: "Semester / Quarter is required." }), { status: 400 });
  }
  if (!startDate || !endDate) {
    return new Response(JSON.stringify({ error: "Requested start and end dates are required." }), { status: 400 });
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  // Confirm this record ID really is a Student record (and grab their email as
  // a sanity cross-check) before linking anything to it — never trust an ID
  // from the client at face value.
  try {
    const checkResp = await fetch(`https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}/${studentRecordId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!checkResp.ok) {
      return new Response(JSON.stringify({ error: "Could not find your student profile — please look yourself up again and retry." }), { status: 404 });
    }
    const checkData: any = await checkResp.json();
    const recordEmail = (checkData?.fields?.["Email"] || "").toString().toLowerCase();
    if (studentEmail && recordEmail && recordEmail !== studentEmail.toLowerCase()) {
      return new Response(JSON.stringify({ error: "Student profile mismatch — please look yourself up again and retry." }), { status: 400 });
    }
  } catch (err: any) {
    return new Response(JSON.stringify({ error: "Could not verify your student profile. Please try again." }), { status: 502 });
  }

  const rotationFields: Record<string, any> = {
    "Student": [studentRecordId],
    "Semester / Quarter": semesterQuarter,
    "College/University": university,
    "Course Name": courseName,
    "Requested Start Date": startDate,
    "Requested End Date": endDate,
    "Clinical Focus / Objectives": clinicalFocus,
    "Special Notes": specialNotes,
    "Pipeline Status": "🟡 Inquiry Received",
    "Admission Status": ["Application Received"],
  };
  if (hoursGoal) rotationFields["Hours Goal"] = hoursGoal;
  Object.keys(rotationFields).forEach((k) => {
    if (rotationFields[k] === "" || rotationFields[k] === null || rotationFields[k] === undefined) delete rotationFields[k];
  });

  try {
    const resp = await fetch(`https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${ROTATIONS_TABLE_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields: rotationFields }], typecast: true }),
    });
    const data: any = await resp.json();
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: data?.error?.message || "Airtable rejected the request." }), { status: resp.status });
    }
    return new Response(JSON.stringify({ ok: true, rotationId: data?.records?.[0]?.id }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Proxy error" }), { status: 502 });
  }
};

export const config: Config = {
  path: "/.netlify/functions/rotation-request-submit",
};
