import { getEnv } from "./config";
import type { UserWipCount } from "./linear";

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
