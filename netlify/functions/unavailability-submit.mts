import type { Context, Config } from "@netlify/functions";

const STUDENTS_BASE_ID = "appf6D9Nbhb5Wg43L";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";
const UNAVAILABILITY_TABLE_ID = "tblrbit6Z4MIyds8F";

function isValidDate(d: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + "T00:00:00").getTime());
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

  const studentEmail = (input.studentEmail || "").toString().trim();
  const startDate = (input.startDate || "").toString().trim();
  const endDate = (input.endDate || startDate || "").toString().trim();
  const reason = (input.reason || "").toString().trim();

  if (!studentEmail) {
    return new Response(JSON.stringify({ error: "Missing student email." }), { status: 400 });
  }
  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return new Response(JSON.stringify({ error: "Please provide a valid start date." }), { status: 400 });
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  try {
    const lookupUrl = `https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${STUDENTS_TABLE_ID}?filterByFormula=${encodeURIComponent(`LOWER({Email})="${studentEmail.toLowerCase()}"`)}`;
    const lookupResp = await fetch(lookupUrl, { headers: { Authorization: `Bearer ${token}` } });
    const lookupData = await lookupResp.json();
    if (!lookupResp.ok) {
      return new Response(JSON.stringify({ error: lookupData?.error?.message || "Could not look up student record." }), { status: lookupResp.status });
    }
    const studentRecordId = lookupData?.records?.[0]?.id;
    if (!studentRecordId) {
      return new Response(JSON.stringify({ error: "Could not find a student record for that email." }), { status: 404 });
    }

    const fields: Record<string, any> = {
      "Student": [studentRecordId],
      "Unavailable Start Date": startDate,
      "Unavailable End Date": endDate,
    };
    if (reason) fields["Reason"] = reason;

    const createResp = await fetch(`https://api.airtable.com/v0/${STUDENTS_BASE_ID}/${UNAVAILABILITY_TABLE_ID}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    const createData = await createResp.json();
    if (!createResp.ok) {
      return new Response(JSON.stringify({ error: createData?.error?.message || "Airtable rejected the submission." }), { status: createResp.status });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Proxy error" }), { status: 502 });
  }
};

export const config: Config = {
  path: "/.netlify/functions/unavailability-submit",
};
