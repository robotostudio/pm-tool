import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { parseQuery } from "../../lib/parse-query";
import { getTimeReport } from "../../lib/db";
import { postSlackBotMessage, buildCycleTimeReportBlocks } from "../../lib/slack";

// Simple in-memory dedup for Slack retries (lasts ~60s in serverless)
const processedEvents = new Set<string>();

export const config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySlackSignature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  signingSecret: string
): boolean {
  // Reject requests older than 5 minutes to prevent replay attacks
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return false;
  }

  const sigBaseString = `v0:${timestamp}:${rawBody.toString()}`;
  const hmac = crypto.createHmac("sha256", signingSecret);
  hmac.update(sigBaseString);
  const expected = `v0=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}

const HELP_TEXT = [
  "*Usage:* mention me with a query like:",
  "• `time on ROB in february` — cycle time for team ROB in February",
  "• `time on TRA last week` — last week's cycle times for TRA",
  "• `time this month` — all teams this month",
  "• `time on ROB from 2025-02-01 to 2025-02-28` — explicit date range",
  "• `time on ROB by John` — filter by assignee",
  "• `help` — show this message",
].join("\n");

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const rawBody = await getRawBody(req);
  const body = JSON.parse(rawBody.toString());

  // Handle Slack URL verification challenge (no signature check needed for this)
  if (body.type === "url_verification") {
    return res.status(200).json({ challenge: body.challenge });
  }

  // Verify Slack request signature
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.error("[slack] SLACK_SIGNING_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }

  const timestamp = req.headers["x-slack-request-timestamp"] as string;
  const signature = req.headers["x-slack-signature"] as string;

  if (!timestamp || !signature) {
    return res.status(401).json({ error: "Missing Slack signature headers" });
  }

  if (!verifySlackSignature(rawBody, timestamp, signature, signingSecret)) {
    console.log("[slack] Signature verification failed");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Respond immediately to avoid Slack's 3-second timeout
  res.status(200).json({ ok: true });

  // Process the event asynchronously
  try {
    await handleEvent(body);
  } catch (err) {
    console.error("[slack] Event processing error:", err);
  }
}

async function handleEvent(body: {
  event_id?: string;
  event?: {
    type: string;
    text?: string;
    channel?: string;
    user?: string;
    bot_id?: string;
  };
}) {
  const event = body.event;
  if (!event) return;

  // Skip bot messages to prevent loops
  if (event.bot_id) return;

  // Dedup retries
  if (body.event_id) {
    if (processedEvents.has(body.event_id)) {
      console.log("[slack] Duplicate event, skipping:", body.event_id);
      return;
    }
    processedEvents.add(body.event_id);
    // Clean up old events after 60s
    setTimeout(() => processedEvents.delete(body.event_id!), 60_000);
  }

  if (event.type !== "app_mention") return;

  const channel = event.channel;
  const rawText = event.text ?? "";

  if (!channel) return;

  // Strip the bot mention (e.g. "<@U12345> time on ROB in feb" -> "time on ROB in feb")
  const text = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();

  console.log("[slack] app_mention:", text, "channel:", channel);

  // Handle help
  if (!text || text.toLowerCase() === "help") {
    await postSlackBotMessage(
      channel,
      [{ type: "section", text: { type: "mrkdwn", text: HELP_TEXT } }],
      "PM Bot usage"
    );
    return;
  }

  // Parse the query
  const query = parseQuery(text);

  console.log("[slack] Parsed query:", JSON.stringify(query));

  try {
    const fromDate = new Date(query.from ?? new Date(Date.now() - 30 * 86400000).toISOString());
    const toDate = new Date(query.to ?? new Date().toISOString());

    let reports = await getTimeReport({
      from: fromDate,
      to: toDate,
      team: query.team,
    });

    // Filter by assignee if specified
    if (query.assignee) {
      const assigneeLower = query.assignee.toLowerCase();
      reports = reports.filter(
        (r) => r.assignee && r.assignee.toLowerCase().includes(assigneeLower)
      );
    }

    const blocks = buildCycleTimeReportBlocks(reports, query);
    const fallbackText = `Cycle time report: ${reports.length} issues`;

    await postSlackBotMessage(channel, blocks, fallbackText);
  } catch (err) {
    console.error("[slack] Query error:", err);
    await postSlackBotMessage(
      channel,
      [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "Sorry, I ran into an error processing your request. Please try again.",
          },
        },
      ],
      "Error processing request"
    );
  }
}
