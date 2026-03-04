/**
 * Test the daily WIP report locally.
 * Posts to Slack if SLACK_WEBHOOK_URL is set, otherwise prints to console.
 *
 * Usage: npx tsx scripts/test-wip.ts
 */
import "dotenv/config";
import { getWipCounts } from "../lib/linear";
import { buildWipReportBlocks, sendSlackMessage } from "../lib/slack";

async function main() {
  console.log("⏳ Fetching WIP counts from Linear...\n");

  const wipData = await getWipCounts();
  const totalWip = wipData.reduce((sum, u) => sum + u.total, 0);

  // Print to console
  console.log(`📊 Total WIP: ${totalWip} items across ${wipData.length} people\n`);

  for (const user of wipData) {
    if (user.total === 0) continue;

    console.log(`  👤 ${user.userName}: ${user.total} items`);
    console.log(`     🔵 In Progress: ${user.inProgress}  🟡 In Review: ${user.inReview}`);

    for (const issue of user.issues.slice(0, 5)) {
      console.log(`       • ${issue.identifier} ${issue.title} [${issue.state} · ${issue.teamName}]`);
    }
    if (user.issues.length > 5) {
      console.log(`       ...and ${user.issues.length - 5} more`);
    }
    console.log();
  }

  // Send to Slack if configured
  if (process.env.SLACK_WEBHOOK_URL) {
    console.log("📤 Sending to Slack...");
    const blocks = buildWipReportBlocks(wipData);
    await sendSlackMessage(blocks, `Daily WIP Report: ${totalWip} items`);
    console.log("✅ Slack message sent!");
  } else {
    console.log("ℹ️  Set SLACK_WEBHOOK_URL in .env to also send to Slack");
  }
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
