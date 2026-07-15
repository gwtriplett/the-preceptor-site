import type { Config } from "@netlify/functions";
import {
  fetchSessions,
  groupByStudentEmail,
  buildMonthlyStaffPdf,
  buildPersonalPdf,
  makeTransport,
  sendPdfEmail,
  isCurrentEasternHour,
  easternDayOfMonth,
} from "./lib/calendar-lib.mts";

const TARGET_HOUR_ET = 7; // 7am Eastern, on the 1st of the month
const fmt = (d: Date) => d.toISOString().slice(0, 10);

export default async () => {
  // FORCE_CALENDAR_SEND is a temporary manual-testing bypass — unset it (or set
  // to anything other than "true") once testing is confirmed working, or every
  // scheduled run will send a duplicate on top of the real 7am-on-the-1st send.
  const forceSend = process.env.FORCE_CALENDAR_SEND === "true";
  if (!forceSend && (!isCurrentEasternHour(TARGET_HOUR_ET) || easternDayOfMonth() !== 1)) {
    return new Response(JSON.stringify({ skipped: true, reason: "Not 7am Eastern on the 1st yet" }), { status: 200 });
  }

  const token = process.env.AIRTABLE_TOKEN;
  const staffEmails = (process.env.STAFF_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!token) return new Response(JSON.stringify({ error: "Missing AIRTABLE_TOKEN" }), { status: 500 });
  if (!staffEmails.length) return new Response(JSON.stringify({ error: "Missing STAFF_EMAILS" }), { status: 500 });

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const startDate = fmt(monthStart);
  const endDate = fmt(monthEnd);
  const label = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

  const sessions = await fetchSessions(token, startDate, endDate);
  const transport = makeTransport();
  const errors: string[] = [];

  try {
    const staffPdf = await buildMonthlyStaffPdf(sessions, monthStart, label);
    await sendPdfEmail(
      transport,
      staffEmails.join(","),
      `Monthly Schedule: ${label}`,
      "Attached is this month's clinical schedule for all students.",
      `monthly-schedule-${startDate}.pdf`,
      staffPdf
    );
  } catch (err: any) {
    errors.push(`Staff email failed: ${err?.message || err}`);
  }

  const byStudent = groupByStudentEmail(sessions);
  let studentsEmailed = 0;
  for (const [email, studentSessions] of byStudent) {
    try {
      const studentName = studentSessions[0]?.["Student Name"] || "Student";
      const pdf = await buildPersonalPdf(studentSessions, studentName, label);
      await sendPdfEmail(
        transport,
        email,
        `Your Monthly Schedule: ${label}`,
        "Attached is your personal clinical schedule for this month.",
        `my-schedule-${startDate}.pdf`,
        pdf
      );
      studentsEmailed++;
    } catch (err: any) {
      errors.push(`Student email to ${email} failed: ${err?.message || err}`);
    }
  }

  return new Response(
    JSON.stringify({ ok: errors.length === 0, sessionCount: sessions.length, studentsEmailed, errors }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
};

export const config: Config = {
  // 1st of every month, at 11:00 and 12:00 UTC — covers 7am EDT and 7am EST.
  // The isCurrentEasternHour guard above ensures only one of these actually sends.
  schedule: "0 11,12 1 * *",
};
