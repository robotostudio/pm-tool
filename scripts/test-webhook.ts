/**
 * Test status change notifications by picking real issues from Linear
 * and sending Slack notifications as if they just transitioned.
 *
 * Usage: npx tsx scripts/test-webhook.ts
 *        npx tsx scripts/test-webhook.ts ROB-123   (specific issue)
 */
import "dotenv/config";
import { getLinearClient } from "../lib/linear";
import { buildStatusChangeBlock, sendSlackMessage } from "../lib/slack";

async function notifyForIssue(issueIdOrKey: string) {
  const linear = getLinearClient();

  console.log(`  ⏳ Fetching ${issueIdOrKey}...`);
  const issue = await linear.issue(issueIdOrKey);
  const state = await issue.state;
  const team = await issue.team;
  const assignee = await issue.assignee;

  if (!state || !team) {
    console.log(`  ⚠️  Skipping — missing state or team`);
    return;
  }

  // Simulate a transition from the previous state type
  const fakeFromState =
    state.type === "completed"
      ? "In Review"
      : state.name.toLowerCase().includes("review")
        ? "In Progress"
        : "Todo";

  const blocks = buildStatusChangeBlock({
    identifier: issue.identifier,
    title: issue.title,
    url: issue.url,
    teamName: team.name,
    assigneeName: assignee?.name ?? null,
    fromState: fakeFromState,
    toState: state.name,
    toStateType: state.type,
  });

  const text = `${issue.identifier} moved to ${state.name}`;
  await sendSlackMessage(blocks, text);

  console.log(`  ✅ ${issue.identifier} → ${state.name} (${assignee?.name ?? "unassigned"})`);
}

async function main() {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.error("❌ SLACK_WEBHOOK_URL is not set in .env");
    process.exit(1);
  }
  if (!process.env.LINEAR_API_KEY) {
    console.error("❌ LINEAR_API_KEY is not set in .env");
    process.exit(1);
  }

  const specificIssue = process.argv[2];

  if (specificIssue) {
    console.log(`\n📤 Sending status change notification for ${specificIssue}:\n`);
    await notifyForIssue(specificIssue);
  } else {
    console.log("\n📤 Simulating 3 transitions (In Progress / In Review / Done):\n");

    const linear = getLinearClient();

    // Find one issue in each state
    const states = [
      { type: "started", label: "In Progress" },
      { type: "started", label: "In Review" },
      { type: "completed", label: "Done" },
    ];

    for (const { type, label } of states) {
      const issues = await linear.issues({
        filter: {
          state: {
            type: { eq: type as any },
            name: { containsIgnoreCase: label.split(" ").pop() },
          },
        },
        first: 1,
      });

      const issue = issues.nodes[0];
      if (issue) {
        await notifyForIssue(issue.id);
      } else {
        console.log(`  ⚠️  No issue found in "${label}" state — skipping`);
      }
    }
  }

  console.log("\n🎉 Done! Check your Slack channel.\n");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
