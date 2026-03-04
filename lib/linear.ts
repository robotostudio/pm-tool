import { LinearClient } from "@linear/sdk";
import { getEnv, getTeamFilter } from "./config";

let client: LinearClient | null = null;

export function getLinearClient(): LinearClient {
  if (!client) {
    client = new LinearClient({ apiKey: getEnv("LINEAR_API_KEY") });
  }
  return client;
}

export interface TeamWipCount {
  teamName: string;
  teamKey: string;
  inProgress: number;
  inReview: number;
  total: number;
  issues: { id: string; identifier: string; title: string; assigneeName: string | null; state: string }[];
}

export async function getWipCounts(): Promise<TeamWipCount[]> {
  const linear = getLinearClient();
  const teamFilter = getTeamFilter();

  const teamsResult = await linear.teams();
  let teams = teamsResult.nodes;

  if (teamFilter.length > 0) {
    teams = teams.filter(
      (t) =>
        teamFilter.includes(t.key.toLowerCase()) ||
        teamFilter.includes(t.name.toLowerCase())
    );
  }

  const results: TeamWipCount[] = [];

  for (const team of teams) {
    const states = await team.states();
    const wipStates = states.nodes.filter(
      (s) => s.type === "started"
    );

    const wipIssues: TeamWipCount["issues"] = [];
    let inProgress = 0;
    let inReview = 0;

    for (const state of wipStates) {
      const issues = await linear.issues({
        filter: {
          team: { id: { eq: team.id } },
          state: { id: { eq: state.id } },
        },
      });

      for (const issue of issues.nodes) {
        const assignee = await issue.assignee;
        const nameLower = state.name.toLowerCase();
        const isReview = nameLower.includes("review");

        if (isReview) {
          inReview += 1;
        } else {
          inProgress += 1;
        }

        wipIssues.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          assigneeName: assignee?.name ?? null,
          state: state.name,
        });
      }
    }

    results.push({
      teamName: team.name,
      teamKey: team.key,
      inProgress,
      inReview,
      total: inProgress + inReview,
      issues: wipIssues,
    });
  }

  return results;
}
