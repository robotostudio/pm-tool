import type { VercelRequest, VercelResponse } from "@vercel/node";
import crypto from "node:crypto";
import { getLinearClient } from "../../lib/linear";
import { buildStatusChangeBlock, sendSlackMessage } from "../../lib/slack";
import { getTeamFilter } from "../../lib/config";

const TRACKED_STATE_TYPES = new Set(["started", "completed"]);

function verifySignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return !secret; // skip verification if no secret configured
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(body);
  const digest = hmac.digest("hex");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(digest));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Allow GET for testing connectivity
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, message: "Webhook endpoint is live" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const payload = req.body;
  console.log("[webhook] Received:", JSON.stringify({ type: payload?.type, action: payload?.action, hasUpdatedFrom: !!payload?.updatedFrom, dataId: payload?.data?.id }));

  // Verify webhook signature
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers["linear-signature"] as string | undefined;
  const secret = process.env.LINEAR_WEBHOOK_SECRET ?? "";

  if (!verifySignature(rawBody, signature, secret)) {
    console.log("[webhook] Signature verification failed");
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Only handle issue updates with state changes
  if (payload.type !== "Issue" || payload.action !== "update") {
    console.log("[webhook] Skipped: not an issue update");
    return res.status(200).json({ ok: true, skipped: "not an issue update" });
  }

  const updatedFrom = payload.updatedFrom;
  if (!updatedFrom?.stateId) {
    console.log("[webhook] Skipped: no state change in updatedFrom");
    return res.status(200).json({ ok: true, skipped: "no state change" });
  }

  try {
    const linear = getLinearClient();
    const issue = await linear.issue(payload.data.id);
    const state = await issue.state;
    const team = await issue.team;
    const assignee = await issue.assignee;

    console.log("[webhook] Issue:", issue.identifier, "State:", state?.name, "Type:", state?.type, "Team:", team?.name);

    if (!state || !team) {
      console.log("[webhook] Skipped: missing state or team");
      return res.status(200).json({ ok: true, skipped: "missing state or team" });
    }

    // Check team filter
    const teamFilter = getTeamFilter();
    if (teamFilter.length > 0) {
      const matchesFilter =
        teamFilter.includes(team.key.toLowerCase()) ||
        teamFilter.includes(team.name.toLowerCase());
      if (!matchesFilter) {
        console.log("[webhook] Skipped: team filtered out", team.key);
        return res.status(200).json({ ok: true, skipped: "team filtered out" });
      }
    }

    // Only notify for tracked state types
    if (!TRACKED_STATE_TYPES.has(state.type)) {
      console.log("[webhook] Skipped: state type not tracked:", state.type);
      return res.status(200).json({ ok: true, skipped: `state type "${state.type}" not tracked` });
    }

    // Get previous state name
    let fromStateName = "Unknown";
    try {
      const prevState = await linear.workflowState(updatedFrom.stateId);
      fromStateName = prevState.name;
    } catch {
      // Ignore — previous state may be deleted
    }

    const blocks = buildStatusChangeBlock({
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
      teamName: team.name,
      assigneeName: assignee?.name ?? null,
      fromState: fromStateName,
      toState: state.name,
      toStateType: state.type,
    });

    const text = `${issue.identifier} moved to ${state.name}`;
    console.log("[webhook] Sending to Slack:", text);
    await sendSlackMessage(blocks, text);

    console.log("[webhook] ✅ Notified:", issue.identifier);
    return res.status(200).json({ ok: true, notified: issue.identifier });
  } catch (err) {
    console.error("[webhook] ❌ Error:", err);
    return res.status(500).json({ error: String(err) });
  }
}
