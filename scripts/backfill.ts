import { config } from "dotenv";
config({ path: ".env.local" });
config();

import { sql } from "@vercel/postgres";
import { LinearClient } from "@linear/sdk";

const FROM = new Date("2025-02-01T00:00:00Z");
const TO = new Date("2025-03-01T00:00:00Z");

async function backfill() {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("Missing LINEAR_API_KEY");

  const linear = new LinearClient({ apiKey });
  const teamFilter = (process.env.TEAM_FILTER ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const teamsResult = await linear.teams();
  let teams = teamsResult.nodes;
  if (teamFilter.length > 0) {
    teams = teams.filter(
      (t) => teamFilter.includes(t.key.toLowerCase()) || teamFilter.includes(t.name.toLowerCase())
    );
  }

  console.log(`Backfilling transitions from ${FROM.toISOString()} to ${TO.toISOString()}`);
  console.log(`Teams: ${teams.map((t) => t.key).join(", ")}`);

  let totalInserted = 0;
  let totalIssues = 0;

  for (const team of teams) {
    console.log(`\nProcessing team: ${team.key} (${team.name})`);

    // Get all issues updated in February or that were active during February
    // We use a broad filter — updatedAt >= Feb 1 catches issues that had activity
    const issues = await linear.issues({
      filter: {
        team: { id: { eq: team.id } },
        updatedAt: { gte: FROM },
      },
      first: 250,
    });

    console.log(`  Found ${issues.nodes.length} issues updated since ${FROM.toISOString()}`);

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

        // Only care about state change events
        if (!toState) continue;

        const transitionedAt = new Date(event.createdAt);

        // Skip transitions outside our window
        // But include transitions before FROM if they enter In Progress/In Review
        // (so we know the state at period start)
        if (transitionedAt > TO) continue;

        // Check if already exists (avoid duplicates on re-run)
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
        totalInserted++;
      }

      if (issueInserted > 0) {
        totalIssues++;
        console.log(`  ${issue.identifier}: ${issueInserted} transitions`);
      }
    }
  }

  console.log(`\nDone. Inserted ${totalInserted} transitions across ${totalIssues} issues.`);
}

backfill().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
