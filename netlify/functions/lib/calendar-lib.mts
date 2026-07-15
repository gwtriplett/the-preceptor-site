// Shared helpers used by weekly-calendar-email.mts and monthly-calendar-email.mts.
// Not a function itself — Netlify only turns top-level files in netlify/functions
// into endpoints, so this file just gets bundled into whichever function imports it.

import PDFDocument from "pdfkit";
import nodemailer from "nodemailer";

export const SESSIONS_BASE_ID = "appXyJfoZAiVyyCwE";
export const SESSIONS_TABLE_ID = "tblxwz24LDstMVrSI";

// Same palette as the main site (index.html --green/--amber/--teal/--red/--gray-400)
export const STATUS_COLORS: Record<string, string> = {
  Approved: "#3B6D11",
  Pending: "#BA7517",
  Completed: "#0F6E56",
  Denied: "#A32D2D",
  "No Show": "#888780",
};
const DEFAULT_COLOR = "#1A73C8";
export function colorFor(status: string | undefined) {
  return STATUS_COLORS[status || ""] || DEFAULT_COLOR;
}

// Netlify's cron scheduler only runs on UTC, and Virginia (Eastern time) shifts
// between EST and EDT twice a year. Rather than hardcode a UTC hour that only
// stays correct for half the year, each function's schedule fires twice a day
// (covering both possible UTC offsets) and this guard only lets it actually
// run once — when the wall-clock time in America/New_York matches.
export function isCurrentEasternHour(targetHour: number): boolean {
  const hourStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  const hour = parseInt(hourStr, 10) % 24;
  return hour === targetHour;
}

export function easternWeekday(): number {
  // 0 = Sunday ... 6 = Saturday, based on the current date in America/New_York
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date());
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[label] ?? new Date().getUTCDay();
}

export function easternDayOfMonth(): number {
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", day: "numeric" }).format(new Date());
  return parseInt(label, 10);
}

export type SessionRecord = {
  id: string;
  "Student Name"?: string;
  "Student Email"?: string;
  "Session Date"?: string;
  "Start Time"?: string;
  "End Time"?: string;
  "Clinical Focus"?: string;
  "Approval Status"?: string;
  [key: string]: any;
};

/** Pull every Session record whose Session Date falls within [startDate, endDate], both YYYY-MM-DD. */
export async function fetchSessions(token: string, startDate: string, endDate: string): Promise<SessionRecord[]> {
  const formula = `AND({Session Date}>='${startDate}',{Session Date}<='${endDate}')`;
  let records: any[] = [];
  let offset: string | undefined;
  do {
    const url =
      `https://api.airtable.com/v0/${SESSIONS_BASE_ID}/${SESSIONS_TABLE_ID}` +
      `?pageSize=100&filterByFormula=${encodeURIComponent(formula)}` +
      (offset ? `&offset=${encodeURIComponent(offset)}` : "");
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data: any = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || `Airtable read failed (${resp.status})`);
    records = records.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return records.map((r: any) => ({ id: r.id, ...r.fields }));
}

/** Groups sessions by lower-cased Student Email. Sessions without an email are skipped. */
export function groupByStudentEmail(sessions: SessionRecord[]): Map<string, SessionRecord[]> {
  const map = new Map<string, SessionRecord[]>();
  for (const s of sessions) {
    const email = (s["Student Email"] || "").toString().trim().toLowerCase();
    if (!email) continue;
    if (!map.has(email)) map.set(email, []);
    map.get(email)!.push(s);
  }
  return map;
}

function pdfToBuffer(draw: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 28 });
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(c as Buffer));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    draw(doc);
    doc.end();
  });
}

function timeSort(a: SessionRecord, b: SessionRecord) {
  return (a["Start Time"] || "").localeCompare(b["Start Time"] || "");
}

function drawLegend(doc: PDFKit.PDFDocument, x: number, y: number) {
  const items = [...Object.entries(STATUS_COLORS)];
  let cx = x;
  doc.fontSize(8).font("Helvetica");
  for (const [label, color] of items) {
    doc.rect(cx, y, 8, 8).fill(color);
    doc.fillColor("#333333").text(label, cx + 12, y - 1);
    cx += 12 + doc.widthOfString(label) + 14;
  }
}

/** Staff PDF: one column per day, Mon-Sun, every session listed with time/name/status. */
export async function buildWeeklyStaffPdf(sessions: SessionRecord[], monday: Date, label: string): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const marginX = 28;
    const pageWidth = doc.page.width - marginX * 2;
    const colGap = 6;
    const colWidth = (pageWidth - colGap * 6) / 7;
    const top = 90;

    doc.fontSize(16).font("Helvetica-Bold").fillColor("#0C447C").text(`Weekly Schedule — ${label}`, marginX, 30);
    drawLegend(doc, marginX, 60);

    const days: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setUTCDate(monday.getUTCDate() + i);
      days.push(d);
    }

    days.forEach((d, i) => {
      const x = marginX + i * (colWidth + colGap);
      const dateStr = d.toISOString().slice(0, 10);
      doc.roundedRect(x, top, colWidth, 20, 3).fill("#E6F1FB");
      doc
        .fillColor("#0C447C")
        .fontSize(9)
        .font("Helvetica-Bold")
        .text(`${dayNames[d.getUTCDay()]} ${d.getUTCMonth() + 1}/${d.getUTCDate()}`, x + 4, top + 5, { width: colWidth - 8 });

      let y = top + 26;
      const daySessions = sessions.filter((s) => s["Session Date"] === dateStr).sort(timeSort);
      for (const s of daySessions) {
        const boxHeight = 42;
        if (y + boxHeight > doc.page.height - 40) break; // simple overflow guard
        doc.roundedRect(x, y, colWidth, boxHeight, 3).fill(colorFor(s["Approval Status"]));
        doc
          .fillColor("#FFFFFF")
          .fontSize(7.5)
          .font("Helvetica-Bold")
          .text(`${s["Start Time"] || "?"}–${s["End Time"] || "?"}`, x + 4, y + 3, { width: colWidth - 8 });
        doc
          .font("Helvetica")
          .fontSize(7.5)
          .text(s["Student Name"] || "Unnamed", x + 4, y + 14, { width: colWidth - 8 });
        doc.fontSize(6.5).text(s["Approval Status"] || "", x + 4, y + 30, { width: colWidth - 8 });
        y += boxHeight + 4;
      }
      if (daySessions.length === 0) {
        doc.fillColor("#999999").fontSize(7.5).font("Helvetica-Oblique").text("No sessions", x + 4, y);
      }
    });
  });
}

/** Staff PDF: classic month grid, small colored pills per session in each day cell. */
export async function buildMonthlyStaffPdf(sessions: SessionRecord[], monthStart: Date, label: string): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const marginX = 28;
    const pageWidth = doc.page.width - marginX * 2;
    const colGap = 4;
    const colWidth = (pageWidth - colGap * 6) / 7;
    const top = 100;
    const rowHeight = 90;

    doc.fontSize(16).font("Helvetica-Bold").fillColor("#0C447C").text(`Monthly Schedule — ${label}`, marginX, 30);
    drawLegend(doc, marginX, 60);

    dayNames.forEach((name, i) => {
      doc
        .fontSize(9)
        .font("Helvetica-Bold")
        .fillColor("#0C447C")
        .text(name, marginX + i * (colWidth + colGap), top - 14, { width: colWidth, align: "center" });
    });

    const year = monthStart.getUTCFullYear();
    const month = monthStart.getUTCMonth();
    const firstDayOfWeek = monthStart.getUTCDay();
    const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

    let row = 0;
    let col = firstDayOfWeek;
    for (let day = 1; day <= daysInMonth; day++) {
      const x = marginX + col * (colWidth + colGap);
      const y = top + row * (rowHeight + colGap);
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      doc.roundedRect(x, y, colWidth, rowHeight, 3).stroke("#E8EBF0");
      doc.fillColor("#444441").fontSize(8).font("Helvetica-Bold").text(String(day), x + 4, y + 3);

      const daySessions = sessions.filter((s) => s["Session Date"] === dateStr).sort(timeSort);
      let py = y + 16;
      const maxVisible = 4;
      daySessions.slice(0, maxVisible).forEach((s) => {
        doc.roundedRect(x + 3, py, colWidth - 6, 13, 2).fill(colorFor(s["Approval Status"]));
        const initials = (s["Student Name"] || "?").split(",")[0].slice(0, 12);
        doc.fillColor("#FFFFFF").fontSize(6.5).font("Helvetica").text(initials, x + 6, py + 2.5, { width: colWidth - 12 });
        py += 15;
      });
      if (daySessions.length > maxVisible) {
        doc
          .fillColor("#666666")
          .fontSize(6.5)
          .font("Helvetica-Oblique")
          .text(`+${daySessions.length - maxVisible} more`, x + 4, py);
      }

      col++;
      if (col > 6) {
        col = 0;
        row++;
      }
    }
  });
}

/** Small personal schedule PDF for one student — just their own sessions in range. */
export async function buildPersonalPdf(sessions: SessionRecord[], studentName: string, label: string): Promise<Buffer> {
  return pdfToBuffer((doc) => {
    doc.fontSize(16).font("Helvetica-Bold").fillColor("#0C447C").text(`Your Schedule — ${label}`, 28, 30);
    doc.fontSize(10).font("Helvetica").fillColor("#444441").text(studentName, 28, 54);
    drawLegend(doc, 28, 72);

    let y = 100;
    const sorted = [...sessions].sort((a, b) => (a["Session Date"] || "").localeCompare(b["Session Date"] || "") || timeSort(a, b));
    if (sorted.length === 0) {
      doc.fontSize(10).fillColor("#666666").font("Helvetica-Oblique").text("No sessions scheduled for this period.", 28, y);
      return;
    }
    for (const s of sorted) {
      const boxH = 34;
      doc.roundedRect(28, y, doc.page.width - 56, boxH, 3).fill(colorFor(s["Approval Status"]));
      doc
        .fillColor("#FFFFFF")
        .fontSize(9)
        .font("Helvetica-Bold")
        .text(`${s["Session Date"] || ""}   ${s["Start Time"] || "?"}–${s["End Time"] || "?"}`, 36, y + 4);
      doc
        .font("Helvetica")
        .fontSize(8.5)
        .text(`${s["Approval Status"] || ""}${s["Clinical Focus"] ? " · " + s["Clinical Focus"] : ""}`, 36, y + 18, {
          width: doc.page.width - 80,
        });
      y += boxH + 6;
      if (y > doc.page.height - 60) {
        doc.addPage();
        y = 40;
      }
    }
  });
}

export function makeTransport() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error("Missing GMAIL_USER or GMAIL_APP_PASSWORD environment variable.");
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

export async function sendPdfEmail(
  transport: ReturnType<typeof nodemailer.createTransport>,
  to: string,
  subject: string,
  text: string,
  filename: string,
  pdf: Buffer
) {
  await transport.sendMail({
    from: process.env.GMAIL_USER,
    to,
    subject,
    text,
    attachments: [{ filename, content: pdf }],
  });
}
