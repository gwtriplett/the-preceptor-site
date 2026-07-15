import type { Config } from "@netlify/functions";
import {
  fetchSessions,
  groupByStudentEmail,
  buildWeeklyStaffPdf,
  buildPersonalPdf,
  makeTransport,
  sendPdfEmail,
  isCurrentEasternHour,
  easternWeekday,
} from "./lib/calendar-lib.mts";

const TARGET_HOUR_ET = 7; // 7am Eastern, every Monday

function mondayOfCurrentWeek(): Date {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sun ... 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday));
  return monday;
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);

export default async () => {
  // This function is scheduled to fire at two candidate UTC times to cover
  // both EST and EDT — only actually run on the one that's really 7am Eastern.
  if (!isCurrentEasternHour(TARGET_HOUR_ET) || easternWeekday() !== 1) {
    return new Response(JSON.stringify({ skipped: true, reason: "Not 7am Eastern on Monday yet" }), { status: 200 });
  }

  const token = process.env.AIRTABLE_TOKEN;
  const staffEmails = (process.env.STAFF_EMAILS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!token) return new Response(JSON.stringify({ error: "Missing AIRTABLE_TOKEN" }), { status: 500 });
  if (!staffEmails.length) return new Response(JSON.stringify({ error: "Missing STAFF_EMAILS" }), { status: 500 });

  const monday = mondayOfCurrentWeek();
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const startDate = fmt(monday);
  const endDate = fmt(sunday);
  const label = `${startDate} to ${endDate}`;

  const sessions = await fetchSessions(token, startDate, endDate);
  const transport = makeTransport();
  const errors: string[] = [];

  try {
    const staffPdf = await buildWeeklyStaffPdf(sessions, monday, label);
    await sendPdfEmail(
      transport,
      staffEmails.join(","),
      `Weekly Schedule: ${label}`,
      "Attached is this week's clinical schedule for all students.",
      `weekly-schedule-${startDate}.pdf`,
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
        `Your Weekly Schedule: ${label}`,
        "Attached is your personal clinical schedule for this week.",
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
  // Mondays at 11:00 and 12:00 UTC — covers 7am EDT and 7am EST.
  // The isCurrentEasternHour guard above ensures only one of these actually sends.
  schedule: "0 11,12 * * 1",
};
