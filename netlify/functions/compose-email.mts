import type { Context, Config } from "@netlify/functions";

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

  const { toEmail, subject, bodyText, fromName, clinicName } = input || {};
  if (!toEmail || !subject || !bodyText) {
    return new Response(JSON.stringify({ error: "toEmail, subject, and bodyText are required." }), { status: 400 });
  }

  const apiKey = Netlify.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(JSON.stringify({ error: "Server is missing ANTHROPIC_API_KEY. Set it in Netlify Site settings > Environment variables." }), { status: 500 });
  }

  const prompt = `You are an email notification assistant for The Preceptor Site / ${clinicName || "TMM Medical Group"}.

Compose a professional, warm plain-text email notification:

TO: ${toEmail}
SUBJECT: ${subject}

CONTENT TO INCLUDE:
${bodyText}

Return ONLY a JSON object (no markdown, no backticks, no preamble) with exactly this structure:
{"subject":"${subject}","text":"full plain text email body here"}

Sign the email from: ${fromName || "The Preceptor Site"}
Include footer: The Preceptor Site | ${clinicName || "TMM Medical Group"} | 3520 High Street, Suite 100, Portsmouth, VA 23707
Keep the tone warm and professional. Do not add information not listed above.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || "Claude API error");
    const raw = (data.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(raw);
    return new Response(JSON.stringify({ ok: true, subject: parsed.subject || subject, text: parsed.text || bodyText }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    // Fall back to the raw, uncomposed text rather than failing outright
    return new Response(JSON.stringify({ ok: true, subject, text: bodyText, fallback: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/.netlify/functions/compose-email",
};
