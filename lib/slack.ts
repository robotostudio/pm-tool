import { getEnv } from "./config";
import type { UserWipCount } from "./linear";
import type { IssueTimeReport } from "./db";
import { formatDuration } from "./linear";
import type { ParsedQuery } from "./parse-query";

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  elements?: { type: string; text: string }[];
  fields?: { type: string; text: string }[];
}

export async function sendSlackMessage(blocks: SlackBlock[], text: string) {
  const webhookUrl = getEnv("SLACK_WEBHOOK_URL");

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, blocks }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Slack webhook failed (${res.status}): ${body}`);
  }
}

export function buildWipReportBlocks(data: UserWipCount[]): SlackBlock[] {
  const totalWip = data.reduce((sum, u) => sum + u.total, 0);
  const totalPeople = data.filter((u) => u.userId !== "__unassigned__").length;
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Daily WIP Report — ${today}`, emoji: true },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${totalWip} items* in progress across *${totalPeople} people*`,
      },
    },
    { type: "divider" },
  ];

  for (const user of data) {
    if (user.total === 0) continue;

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${user.userName}*  —  In Progress: *${user.inProgress}*  |  In Review: *${user.inReview}*`,
      },
    });

    // Split issues into chunks of 5 to stay within Slack's 3000 char block limit
    const CHUNK_SIZE = 5;
    for (let i = 0; i < user.issues.length; i += CHUNK_SIZE) {
      const chunk = user.issues.slice(i, i + CHUNK_SIZE);
      const lines = chunk
        .map((issue) => {
          const stateTag = issue.state.toLowerCase().includes("review") ? "[review]" : "[in progress]";
          const durationStr = issue.duration ? ` — ${issue.duration}` : "";
          return `<${issue.url}|${issue.identifier}>  ${issue.title}\n      _${stateTag} ${issue.teamName}${durationStr}_`;
        })
        .join("\n");

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: lines },
      });
    }

    blocks.push({ type: "divider" });
  }

  return blocks;
}

/**
 * Post a message to a Slack channel using the Bot token (Web API).
 * Used for bot replies — different from sendSlackMessage which uses incoming webhook.
 */
export async function postSlackBotMessage(
  channel: string,
  blocks: SlackBlock[],
  text: string
): Promise<void> {
  const token = getEnv("SLACK_BOT_TOKEN");

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel, blocks, text }),
  });

  const data = (await res.json()) as { ok: boolean; error?: string };
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }
}

/**
 * Build Slack blocks for a cycle time report.
 */
export function buildCycleTimeReportBlocks(
  reports: IssueTimeReport[],
  query: ParsedQuery
): SlackBlock[] {
  const teamLabel = query.team ?? "All teams";
  const periodLabel =
    query.from && query.to ? `${query.from} → ${query.to}` : "Last 30 days";

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Cycle Time Report — ${teamLabel}`,
        emoji: true,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Period:* ${periodLabel}\n*Issues:* ${reports.length}`,
      },
    },
    { type: "divider" },
  ];

  if (reports.length === 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: "No issues found for this period." },
    });
    return blocks;
  }

  // Show top 20 issues to stay within Slack limits
  const shown = reports.slice(0, 20);

  for (const r of shown) {
    const assignee = r.assignee ?? "Unassigned";
    const inProg = formatDuration(r.inProgressMs);
    const inRev = formatDuration(r.inReviewMs);
    const total = formatDuration(r.totalMs);

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${r.identifier}*  —  ${assignee}\n_In Progress:_ ${inProg}  |  _In Review:_ ${inRev}  |  *Total: ${total}*`,
      },
    });
  }

  if (reports.length > 20) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `_...and ${reports.length - 20} more issues_`,
      },
    });
  }

  // Summary
  const totalInProgressMs = reports.reduce((s, r) => s + r.inProgressMs, 0);
  const totalInReviewMs = reports.reduce((s, r) => s + r.inReviewMs, 0);
  const totalMs = totalInProgressMs + totalInReviewMs;
  const avgMs = reports.length > 0 ? totalMs / reports.length : 0;

  blocks.push({ type: "divider" });
  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*Summary*\nTotal in-progress: ${formatDuration(totalInProgressMs)}  |  Total in-review: ${formatDuration(totalInReviewMs)}\n*Average cycle time: ${formatDuration(avgMs)}*`,
    },
  });

  return blocks;
}

export function buildStatusChangeBlock(event: {
  identifier: string;
  title: string;
  url: string;
  teamName: string;
  assigneeName: string | null;
  fromState: string;
  toState: string;
  toStateType: string;
  cycleTime: string | null;
  totalCycleTime: string | null;
}): SlackBlock[] {
  const assignee = event.assigneeName ?? "Unassigned";

  const lines = [
    `*<${event.url}|${event.identifier}>* moved to *${event.toState}*`,
    `${event.title}`,
    `*${assignee}*  |  ${event.teamName}`,
    `_${event.fromState} → ${event.toState}_`,
  ];

  if (event.cycleTime) {
    lines.push(`*${event.cycleTime}* in _${event.fromState}_`);
  }

  if (event.totalCycleTime) {
    lines.push(`*${event.totalCycleTime}* total since _In Progress_`);
  }

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: lines.join("\n"),
      },
    },
  ];
}
