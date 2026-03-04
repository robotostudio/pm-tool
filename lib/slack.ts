import { getEnv } from "./config";

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

export function buildWipReportBlocks(
  data: {
    teamName: string;
    teamKey: string;
    inProgress: number;
    inReview: number;
    total: number;
    issues: { identifier: string; title: string; assigneeName: string | null; state: string }[];
  }[]
): SlackBlock[] {
  const totalWip = data.reduce((sum, t) => sum + t.total, 0);
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    month: "short",
    day: "numeric",
  });

  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `📊 Daily WIP Report — ${today}`, emoji: true },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Total WIP across all teams: ${totalWip}*` },
    },
    { type: "divider" },
  ];

  for (const team of data) {
    if (team.total === 0) continue;

    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${team.teamName}* (${team.teamKey})`,
      },
      fields: [
        { type: "mrkdwn", text: `🔵 In Progress: *${team.inProgress}*` },
        { type: "mrkdwn", text: `🟡 In Review: *${team.inReview}*` },
      ],
    });

    if (team.issues.length > 0) {
      const issueLines = team.issues
        .slice(0, 10)
        .map((i) => {
          const assignee = i.assigneeName ? ` → ${i.assigneeName}` : "";
          return `• \`${i.identifier}\` ${i.title} [${i.state}]${assignee}`;
        })
        .join("\n");

      const extra = team.issues.length > 10 ? `\n_...and ${team.issues.length - 10} more_` : "";

      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: issueLines + extra },
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
}): SlackBlock[] {
  const emoji =
    event.toStateType === "completed"
      ? "✅"
      : event.toState.toLowerCase().includes("review")
        ? "🔍"
        : "🚀";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: [
          `${emoji} *<${event.url}|${event.identifier}>* moved to *${event.toState}*`,
          `*${event.title}*`,
          `Team: ${event.teamName}${event.assigneeName ? ` • Assignee: ${event.assigneeName}` : ""}`,
          `_${event.fromState} → ${event.toState}_`,
        ].join("\n"),
      },
    },
  ];
}
