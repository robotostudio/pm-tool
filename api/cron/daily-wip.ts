import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getWipCounts } from "../../lib/linear";
import { buildWipReportBlocks, sendSlackMessage } from "../../lib/slack";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Verify auth — accept either:
  // 1. Vercel cron header: Authorization: Bearer <CRON_SECRET>
  // 2. Manual trigger: ?token=<CRON_SECRET>
  const authHeader = req.headers.authorization;
  const queryToken = req.query.token as string | undefined;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const headerOk = authHeader === `Bearer ${cronSecret}`;
    const tokenOk = queryToken === cronSecret;
    if (!headerOk && !tokenOk) {
      return res.status(401).json({ error: "Unauthorized" });
    }
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
    return res.status(500).json({ error: String(err) });
  }
}
