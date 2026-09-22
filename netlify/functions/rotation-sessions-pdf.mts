import type { Context, Config } from "@netlify/functions";
import PDFDocument from "pdfkit";

const BASE_ID = "appf6D9Nbhb5Wg43L";
const ROTATIONS_TABLE_ID = "tbl6l75OeBLNzSp0i";
const SESSIONS_TABLE_ID = "tblBC5TiAa8VEII9d";
const STUDENTS_TABLE_ID = "tblesg1u5m2ec3cgg";

// Same palette as calendar-lib.mts / the main site's status badges.
const STATUS_COLORS: Record<string, string> = {
  Approved: "#3B6D11",
  Pending: "#BA7517",
  Completed: "#0F6E56",
  Denied: "#A32D2D",
  "No Show": "#888780",
};
function colorFor(status: string | undefined) {
  return STATUS_COLORS[status || ""] || "#1A73C8";
}

function fmtDate(d: string): string {
  if (!d) return "";
  const dt = new Date(d + "T00:00:00");
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function pdfToBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 40 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });
}

// This endpoint is read-only and unauthenticated, matching airtable-read.mts —
// it only ever produces a PDF from data already visible in the student
// portal / staff scheduler, nothing more sensitive than that.
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const rotationId = (url.searchParams.get("rotationId") || "").trim();
  if (!/^rec[A-Za-z0-9]{14,}$/.test(rotationId)) {
    return new Response(JSON.stringify({ error: "A valid rotationId is required." }), { status: 400 });
  }

  const token = Netlify.env.get("AIRTABLE_TOKEN");
  if (!token) {
    return new Response(JSON.stringify({ error: "Server is missing AIRTABLE_TOKEN. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  try {
    const rotResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${ROTATIONS_TABLE_ID}/${rotationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rotation: any = await rotResp.json();
    if (!rotResp.ok) {
      return new Response(JSON.stringify({ error: rotation?.error?.message || "Rotation not found." }), { status: rotResp.status });
    }
    const rf = rotation.fields || {};

    let studentName = rf["Placement Label"] || "";
    const studentIds: string[] = rf["Student"] || [];
    if (studentIds.length) {
      const sResp = await fetch(`https://api.airtable.com/v0/${BASE_ID}/${STUDENTS_TABLE_ID}/${studentIds[0]}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const sData: any = await sResp.json();
      if (sResp.ok && sData.fields?.["Student Name"]) studentName = sData.fields["Student Name"];
    }

    // The Rotation's own "Sessions" link field already lists exactly which
    // Session records belong to it — far simpler and more reliable than
    // trying to filter the Sessions table by a linked Rotation's record ID
    // (Airtable formulas only expose a linked record's primary-field text,
    // and Rotations' primary field is often the same student name repeated
    // across all of that student's rotations, so it can't disambiguate).
    const sessionIds: string[] = (rf["Sessions"] || []).map((s: any) => s.id);
    let sessions: any[] = [];
    if (sessionIds.length) {
      const formula = `OR(${sessionIds.map((id) => `RECORD_ID()="${id}"`).join(",")})`;
      const sessResp = await fetch(
        `https://api.airtable.com/v0/${BASE_ID}/${SESSIONS_TABLE_ID}?filterByFormula=${encodeURIComponent(formula)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const sessData: any = await sessResp.json();
      if (sessResp.ok) sessions = (sessData.records || []).map((r: any) => ({ id: r.id, ...r.fields }));
    }
    sessions.sort((a, b) => (a["Session Date"] || "").localeCompare(b["Session Date"] || "") || (a["Start Time"] || "").localeCompare(b["Start Time"] || ""));

    const courseName = rf["Course Name"] || "Clinical Rotation";
    const semester = rf["Semester / Quarter"] || "";
    const dateRange = rf["Requested Start Date"] && rf["Requested End Date"]
      ? `${fmtDate(rf["Requested Start Date"])} – ${fmtDate(rf["Requested End Date"])}`
      : "";
    const hoursGoal = typeof rf["Hours Goal"] === "number" ? rf["Hours Goal"] : null;
    const totalSignedOff = sessions.reduce((sum, s) => sum + (Number(s["Hours Signed Off"]) || 0), 0);

    const pdf = await pdfToBuffer((doc) => {
      doc.fontSize(16).font("Helvetica-Bold").fillColor("#0C447C").text(courseName, 40, 40);
      doc.fontSize(10).font("Helvetica").fillColor("#444441").text(studentName, 40, 62);
      const metaParts = [semester, dateRange].filter(Boolean);
      if (metaParts.length) doc.fontSize(9).fillColor("#666666").text(metaParts.join(" · "), 40, 78);
      if (hoursGoal != null) {
        doc.fontSize(9).fillColor("#666666").text(`${totalSignedOff.toFixed(1)} of ${hoursGoal} hours signed off`, 40, 92);
      }

      // Legend
      let lx = 40;
      const ly = 110;
      doc.fontSize(8).font("Helvetica");
      Object.entries(STATUS_COLORS).forEach(([label, color]) => {
        doc.rect(lx, ly, 8, 8).fill(color);
        doc.fillColor("#333333").text(label, lx + 12, ly - 1);
        lx += 12 + doc.widthOfString(label) + 14;
      });

      let y = 132;
      if (sessions.length === 0) {
        doc.fontSize(10).fillColor("#666666").font("Helvetica-Oblique").text("No sessions on file for this rotation.", 40, y);
        return;
      }
      for (const s of sessions) {
        const boxH = 42;
        if (y + boxH > doc.page.height - 50) {
          doc.addPage();
          y = 40;
        }
        doc.roundedRect(40, y, doc.page.width - 80, boxH, 3).fill(colorFor(s["Approval Status"]));
        doc
          .fillColor("#FFFFFF")
          .fontSize(9.5)
          .font("Helvetica-Bold")
          .text(`${fmtDate(s["Session Date"] || "")}   ${s["Start Time"] || "?"}–${s["End Time"] || "?"}   (${s["Hours This Session"] ?? "?"} hrs)`, 48, y + 5);
        const statusLine = [s["Approval Status"] || "", s["Clinical Focus"] || ""].filter(Boolean).join(" · ");
        doc.font("Helvetica").fontSize(8.5).text(statusLine, 48, y + 20, { width: doc.page.width - 96 });
        if (s["Hours Signed Off"]) {
          doc.fontSize(8).text(`✓ ${s["Hours Signed Off"]} hrs signed off${s["Signed Off By"] ? " by " + s["Signed Off By"] : ""}`, 48, y + 31);
        }
        y += boxH + 6;
      }
    });

    const filenameSafe = `${(studentName || "student").replace(/[^a-z0-9]+/gi, "-")}-${(courseName || "rotation").replace(/[^a-z0-9]+/gi, "-")}`.toLowerCase();
    return new Response(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filenameSafe}.pdf"`,
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Could not generate PDF." }), { status: 502 });
  }
};

export const config: Config = {
  path: "/.netlify/functions/rotation-sessions-pdf",
};
