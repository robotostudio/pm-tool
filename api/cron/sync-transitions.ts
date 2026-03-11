import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getLinearClient } from "../../lib/linear";
import { getTeamFilter } from "../../lib/config";
import { sql } from "@vercel/postgres";

/**
 * Daily cron that syncs state transitions from Linear into the DB.
 * Queries issues updated in the last 26 hours (overlap to avoid gaps),
 * fetches their history, and inserts any transitions not already recorded.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[sync] CRON_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const stats = await syncRecentTransitions();
    console.log(`[sync] Done. ${stats.inserted} transitions from ${stats.issues} issues.`);
    return res.status(200).json({ ok: true, ...stats });
  } catch (err) {
    console.error("[sync] Failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

export async function syncRecentTransitions(lookbackMs = 26 * 60 * 60 * 1000) {
  const linear = getLinearClient();
  const teamFilter = getTeamFilter();
  const since = new Date(Date.now() - lookbackMs);

  const teamsResult = await linear.teams();
  let teams = teamsResult.nodes;
  if (teamFilter.length > 0) {
    teams = teams.filter(
      (t) =>
        teamFilter.includes(t.key.toLowerCase()) ||
        teamFilter.includes(t.name.toLowerCase())
    );
  }

  let totalInserted = 0;
  let totalIssues = 0;

  for (const team of teams) {
    const issues = await linear.issues({
      filter: {
        team: { id: { eq: team.id } },
        updatedAt: { gte: since },
      },
      first: 250,
    });

    for (const issue of issues.nodes) {
      const history = await issue.history();
      const assignee = await issue.assignee;
      const assigneeName = assignee?.name ?? null;

      const sorted = [...history.nodes].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );

      let issueInserted = 0;

      for (const event of sorted) {
        const toState = await event.toState;
        const fromState = await event.fromState;
        if (!toState) continue;

        const transitionedAt = new Date(event.createdAt);

        // Check if already exists
        const existing = await sql`
          SELECT id FROM state_transitions
          WHERE issue_id = ${issue.id}
            AND to_state = ${toState.name}
            AND transitioned_at = ${transitionedAt.toISOString()}
          LIMIT 1
        `;
        if (existing.rows.length > 0) continue;

        await sql`
          INSERT INTO state_transitions (issue_id, identifier, from_state, to_state, assignee_name, transitioned_at)
          VALUES (${issue.id}, ${issue.identifier}, ${fromState?.name ?? null}, ${toState.name}, ${assigneeName}, ${transitionedAt.toISOString()})
        `;
        issueInserted++;
      }

      if (issueInserted > 0) {
        totalInserted += issueInserted;
        totalIssues++;
        console.log(`[sync] ${issue.identifier}: ${issueInserted} new transitions`);
      }
    }
  }

  return { inserted: totalInserted, issues: totalIssues };
}
