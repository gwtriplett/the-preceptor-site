import type { Context, Config } from "@netlify/functions";
import { makeTransport } from "./lib/calendar-lib.mts";

const PORTAL_URL = "https://sked.thepreceptorsite.com";

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

  const expectedPassword = Netlify.env.get("STAFF_PASSWORD");
  if (!expectedPassword) {
    return new Response(JSON.stringify({ error: "Server is missing STAFF_PASSWORD. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }
  if (!input.staffPassword || input.staffPassword !== expectedPassword) {
    return new Response(JSON.stringify({ error: "Not authorized." }), { status: 401 });
  }

  const students = Array.isArray(input.students) ? input.students : [];
  if (students.length === 0) {
    return new Response(JSON.stringify({ error: "No students provided." }), { status: 400 });
  }

  let transport;
  try {
    transport = makeTransport();
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || "Email transport not configured." }), { status: 500 });
  }

  const results: { email: string; ok: boolean; error?: string }[] = [];
  for (const raw of students) {
    const email = (raw?.email || "").toString().trim();
    const name = (raw?.name || "Student").toString().trim();
    const studentId = (raw?.studentId || "").toString().trim();
    if (!email) {
      results.push({ email: "", ok: false, error: "Missing email" });
      continue;
    }
    const loginOptions = studentId
      ? `- Your email address: ${email}\n- Or your Student ID: ${studentId}`
      : `- Your email address: ${email}`;
    try {
      await transport.sendMail({
        from: process.env.GMAIL_USER,
        to: email,
        subject: "Your Clinical Hours Scheduler Access — The Preceptor Site",
        text: `Dear ${name},\n\nYou can now access your clinical hours scheduler online at:\n${PORTAL_URL}\n\nOn the login screen, select "Student" and log in with either:\n${loginOptions}\n\nNo password is needed.\n\nFrom your portal you can:\n- Request and view your clinical sessions\n- Track your completed hours toward your requirement\n- Submit required documents\n- Update your contact information\n- Let your coordinator know about upcoming unavailable dates\n\nQuestions? Just reply to this email.\n\nThe Preceptor Site\n3520 High Street, Suite 100, Portsmouth, VA 23707`,
      });
      results.push({ email, ok: true });
    } catch (err: any) {
      results.push({ email, ok: false, error: err?.message || "Send failed" });
    }
  }

  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);

  return new Response(JSON.stringify({ ok: failed.length === 0, sent, failed }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

export const config: Config = {
  path: "/.netlify/functions/send-portal-access-emails",
};
