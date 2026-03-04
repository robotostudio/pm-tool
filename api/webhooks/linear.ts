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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Verify webhook signature
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers["linear-signature"] as string | undefined;
  const secret = process.env.LINEAR_WEBHOOK_SECRET ?? "";

  if (!verifySignature(rawBody, signature, secret)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const payload = req.body;

  // Only handle issue updates with state changes
  if (payload.type !== "Issue" || payload.action !== "update") {
    return res.status(200).json({ ok: true, skipped: "not an issue update" });
  }

  const updatedFrom = payload.updatedFrom;
  if (!updatedFrom?.stateId) {
    return res.status(200).json({ ok: true, skipped: "no state change" });
  }

  try {
    const linear = getLinearClient();
    const issue = await linear.issue(payload.data.id);
    const state = await issue.state;
    const team = await issue.team;
    const assignee = await issue.assignee;

    if (!state || !team) {
      return res.status(200).json({ ok: true, skipped: "missing state or team" });
    }

    // Check team filter
    const teamFilter = getTeamFilter();
    if (teamFilter.length > 0) {
      const matchesFilter =
        teamFilter.includes(team.key.toLowerCase()) ||
        teamFilter.includes(team.name.toLowerCase());
      if (!matchesFilter) {
        return res.status(200).json({ ok: true, skipped: "team filtered out" });
      }
    }

    // Only notify for tracked state types
    if (!TRACKED_STATE_TYPES.has(state.type)) {
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
    await sendSlackMessage(blocks, text);

    return res.status(200).json({ ok: true, notified: issue.identifier });
  } catch (err) {
    console.error("Webhook handler failed:", err);
    return res.status(500).json({ error: String(err) });
  }
}
