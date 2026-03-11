import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getTimeReport, type IssueTimeReport } from "../../lib/db";
import { formatDuration } from "../../lib/linear";

function formatHours(ms: number): string {
  const hours = ms / 3600000;
  return `${Math.round(hours * 10) / 10}h`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Protect with CRON_SECRET (fail-closed: reject if not configured)
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error("[report] CRON_SECRET not configured");
    return res.status(500).json({ error: "Server misconfigured" });
  }
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { team, from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      error: "Missing required params: from, to",
      usage: "GET /api/reports/cycle-time?team=ROB&from=2025-02-01&to=2025-03-01",
    });
  }

  const fromDate = new Date(from as string);
  const toDate = new Date(to as string);

  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(400).json({ error: "Invalid date format. Use ISO dates like 2025-02-01" });
  }

  try {
    const reports = await getTimeReport({
      from: fromDate,
      to: toDate,
      team: team as string | undefined,
    });

    const issues = reports.map((r: IssueTimeReport) => ({
      identifier: r.identifier,
      assignee: r.assignee ?? "Unassigned",
      inProgress: formatHours(r.inProgressMs),
      inReview: formatHours(r.inReviewMs),
      total: formatHours(r.totalMs),
      totalReadable: formatDuration(r.totalMs),
    }));

    const totalInProgressMs = reports.reduce((sum, r) => sum + r.inProgressMs, 0);
    const totalInReviewMs = reports.reduce((sum, r) => sum + r.inReviewMs, 0);
    const totalMs = totalInProgressMs + totalInReviewMs;

    return res.status(200).json({
      ok: true,
      period: { from: from as string, to: to as string },
      team: (team as string) || "all",
      issueCount: issues.length,
      totals: {
        inProgress: formatHours(totalInProgressMs),
        inReview: formatHours(totalInReviewMs),
        total: formatHours(totalMs),
        totalReadable: formatDuration(totalMs),
      },
      issues,
    });
  } catch (err) {
    console.error("[report] Error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
