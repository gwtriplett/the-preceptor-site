import type { Context, Config } from "@netlify/functions";

const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";
const ROTATIONS_TABLE_ID = "tbl6l75OeBLNzSp0i";

function last4(phone: string) {
  const digits = (phone || "").replace(/\D/g, "");
  return digits.slice(-4).padStart(4, "0");
}

async function airtableFetch(token: string, path: string, init: RequestInit = {}) {
  const resp = await fetch(`https://api.airtable.com/v0/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await resp.json();
  return { resp, data };
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
  const semesterQuarter = (input.semesterQuarter || "").toString().trim();
  const courseName = (input.courseName || "").toString().trim();

  if (!firstName || !lastName || !email || !phone) {
    return new Response(JSON.stringify({ error: "First name, last name, email, and phone are required." }), { status: 400 });
  }
  if (!semesterQuarter) {
    return new Response(JSON.stringify({ error: "Semester / Quarter is required." }), { status: 400 });
  }
  if (!courseName) {
    return new Response(JSON.stringify({ error: "Course name is required." }), { status: 400 });
  }

  const startDate = (input.startDate || "").toString();
  const yy = startDate
    ? String(new Date(startDate + "T00:00:00").getFullYear()).slice(-2)
    : String(new Date().getFullYear()).slice(-2);
  const studentName = `${lastName}, ${firstName}`;

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  try {
    // --- Step 1: look for an existing Student by email. Returning students ---
    // --- get a new Rotation linked to their existing profile, not a new person.
    const emailForFormula = email.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const { resp: findResp, data: findData } = await airtableFetch(
      token,
      `${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}?filterByFormula=${encodeURIComponent(
        `LOWER({Email}) = LOWER("${emailForFormula}")`
      )}&maxRecords=1`
    );
    if (!findResp.ok) {
      return new Response(JSON.stringify({ error: findData?.error?.message || "Airtable lookup failed." }), { status: findResp.status });
    }

    let studentRecordId: string | undefined = findData?.records?.[0]?.id;
    let studentId: string;

    if (studentRecordId) {
      // Returning student — reuse their existing record. Keep contact info fresh
      // but never touch anything rotation-specific (that all lives on Rotations now).
      studentId = findData.records[0].fields["Student ID"] || `${yy}-${last4(phone)}`;

      const refreshFields: Record<string, any> = {
        "Phone Number": phone,
        "Current Address": (input.address || "").toString().trim(),
        "University / College": (input.university || "").toString().trim(),
        "Degree / Program": (input.program || "").toString().trim(),
        "University Supervisor Name": (input.supervisorName || "").toString().trim(),
        "University Supervisor Email": (input.supervisorEmail || "").toString().trim(),
      };
      Object.keys(refreshFields).forEach((k) => {
        if (refreshFields[k] === "") delete refreshFields[k];
      });

      const { resp: updateResp, data: updateData } = await airtableFetch(
        token,
        `${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}/${studentRecordId}`,
        { method: "PATCH", body: JSON.stringify({ fields: refreshFields, typecast: true }) }
      );
      if (!updateResp.ok) {
        // Non-fatal — the student record still exists and links fine even if the refresh failed.
        console.error("Student refresh failed", updateData);
      }
    } else {
      // New student — create their one-time profile with identity/contact fields only.
      studentId = `${yy}-${last4(phone)}`;

      const studentFields: Record<string, any> = {
        "Student Name": studentName,
        "First Name": firstName,
        "Last Name": lastName,
        "Student ID": studentId,
        "Email": email,
        "Phone Number": phone,
        "Current Address": (input.address || "").toString().trim(),
        "University / College": (input.university || "").toString().trim(),
        "Degree / Program": (input.program || "").toString().trim(),
        "University Supervisor Name": (input.supervisorName || "").toString().trim(),
        "University Supervisor Email": (input.supervisorEmail || "").toString().trim(),
        "Resume Link": (input.resumeLink || "").toString().trim(),
        "School Handbook Link": (input.handbookLink || "").toString().trim(),
        "Intake Source": "Website Form",
        "Intake Timestamp": new Date().toISOString(),
      };
      Object.keys(studentFields).forEach((k) => {
        if (studentFields[k] === "" || studentFields[k] === null) delete studentFields[k];
      });

      const { resp: createResp, data: createData } = await airtableFetch(
        token,
        `${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}`,
        { method: "POST", body: JSON.stringify({ records: [{ fields: studentFields }], typecast: true }) }
      );
      if (!createResp.ok) {
        return new Response(JSON.stringify({ error: createData?.error?.message || "Airtable rejected the submission." }), { status: createResp.status });
      }
      studentRecordId = createData?.records?.[0]?.id;
    }

    // --- Step 2: always create a fresh Rotation, linked to the student above. ---
    // Every submission — new student or returning — gets its own Rotation record,
    // which is where course, hours, dates, and status for THIS placement live.
    const rotationFields: Record<string, any> = {
      // Name only (no dates) so all of a student's rotations sort/group together.
      "Placement Label": studentName,
      "Student": studentRecordId ? [studentRecordId] : undefined,
      "Semester / Quarter": semesterQuarter,
      "College/University": (input.university || "").toString().trim(),
      "Course Name": courseName,
      "Hours Goal": Number(input.hoursRequired) || null,
      "Requested Start Date": startDate || null,
      "Requested End Date": (input.endDate || "").toString() || null,
      "Additional Period Requested?": input.additionalPeriod ? "Yes" : "No",
      "Clinical Focus / Objectives": (input.clinicalFocus || "").toString().trim(),
      "Special Notes": (input.specialNotes || "").toString().trim(),
      "Pipeline Status": "🟡 Inquiry Received",
      "Admission Status": ["Application Received"],
    };
    if (input.additionalPeriod) {
      rotationFields["Additional Period - Start Date"] = (input.addStartDate || "").toString() || null;
      rotationFields["Additional Period - End Date"] = (input.addEndDate || "").toString() || null;
    }
    Object.keys(rotationFields).forEach((k) => {
      if (rotationFields[k] === "" || rotationFields[k] === null || rotationFields[k] === undefined) delete rotationFields[k];
    });

    const { resp: rotationResp, data: rotationData } = await airtableFetch(
      token,
      `${STUDENTS_BASE_ID}/${ROTATIONS_TABLE_ID}`,
      { method: "POST", body: JSON.stringify({ records: [{ fields: rotationFields }], typecast: true }) }
    );
    if (!rotationResp.ok) {
      // The student record is already saved at this point — surface the rotation
      // error but don't pretend the whole submission failed silently.
      return new Response(
        JSON.stringify({ error: rotationData?.error?.message || "Your info was saved, but we couldn't create the rotation record. Please contact your coordinator." }),
        { status: rotationResp.status }
      );
    }

    // --- Step 3: best-effort resume upload — attaches to the student's profile. ---
    // Note: uploads go through content.airtable.com, a different host than the
    // regular api.airtable.com calls above — do not route this through airtableFetch.
    let resumeUploadWarning: string | null = null;
    if (studentRecordId && input.resumeFile && input.resumeFile.base64) {
      try {
        const uploadResp = await fetch(
          `https://content.airtable.com/v0/${STUDENTS_BASE_ID}/${studentRecordId}/fldABGJevUP9LbewM/uploadAttachment`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              contentType: input.resumeFile.contentType || "application/octet-stream",
              file: input.resumeFile.base64,
              filename: input.resumeFile.filename || "resume",
            }),
          }
        );
        if (!uploadResp.ok) {
          resumeUploadWarning = "Your info was saved, but the resume file didn't upload. Please email it to your coordinator directly.";
        }
      } catch {
        resumeUploadWarning = "Your info was saved, but the resume file didn't upload. Please email it to your coordinator directly.";
      }
    }

    return new Response(JSON.stringify({ ok: true, studentId, resumeUploadWarning }), {
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
