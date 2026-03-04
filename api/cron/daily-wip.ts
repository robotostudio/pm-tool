import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getWipCounts } from "../../lib/linear";
import { buildWipReportBlocks, sendSlackMessage } from "../../lib/slack";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify cron secret (Vercel sends this header for cron jobs)
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const wipData = await getWipCounts();
    const totalWip = wipData.reduce((sum, t) => sum + t.total, 0);

    const blocks = buildWipReportBlocks(wipData);
    const text = `Daily WIP Report: ${totalWip} items in progress`;

    await sendSlackMessage(blocks, text);

    return res.status(200).json({
      ok: true,
      totalWip,
      teams: wipData.map((t) => ({
        team: t.teamName,
        inProgress: t.inProgress,
        inReview: t.inReview,
      })),
    });
  } catch (err) {
    console.error("Daily WIP cron failed:", err);
    return res.status(500).json({ error: String(err) });
  }
}
