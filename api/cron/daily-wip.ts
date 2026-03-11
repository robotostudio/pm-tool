import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getWipCounts } from "../../lib/linear";
import { buildWipReportBlocks, sendSlackMessage } from "../../lib/slack";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret (sent by Vercel cron and manual dashboard triggers)
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[wip] CRON_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const wipData = await getWipCounts();
    const totalWip = wipData.reduce((sum, u) => sum + u.total, 0);

    const blocks = buildWipReportBlocks(wipData);
    const text = `Daily WIP Report: ${totalWip} items across ${wipData.length} people`;

    await sendSlackMessage(blocks, text);

    return res.status(200).json({
      ok: true,
      totalWip,
      people: wipData.map((u) => ({
        user: u.userName,
        inProgress: u.inProgress,
        inReview: u.inReview,
      })),
    });
  } catch (err) {
    console.error("Daily WIP cron failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
