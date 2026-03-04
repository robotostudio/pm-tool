/**
 * Test Slack webhook by sending a real WIP report from Linear.
 *
 * Usage: npx tsx scripts/test-slack.ts
 */
import "dotenv/config";
import { getWipCounts } from "../lib/linear";
import { buildWipReportBlocks, sendSlackMessage } from "../lib/slack";

async function main() {
  if (!process.env.SLACK_WEBHOOK_URL) {
    console.error("❌ SLACK_WEBHOOK_URL is not set in .env");
    process.exit(1);
  }

  if (!process.env.LINEAR_API_KEY) {
    console.error("❌ LINEAR_API_KEY is not set in .env");
    process.exit(1);
  }

  console.log("⏳ Fetching real WIP data from Linear...\n");

  const wipData = await getWipCounts();
  const totalWip = wipData.reduce((sum, u) => sum + u.total, 0);

  // Print summary to console
  console.log(`📊 Found ${totalWip} WIP items across ${wipData.length} people:\n`);
  for (const user of wipData) {
    console.log(`  👤 ${user.userName}: ${user.inProgress} in progress, ${user.inReview} in review`);
  }

  console.log("\n📤 Sending to Slack...");
  const blocks = buildWipReportBlocks(wipData);
  await sendSlackMessage(blocks, `Daily WIP Report: ${totalWip} items across ${wipData.length} people`);
  console.log("✅ Slack message sent! Check your channel.");
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
