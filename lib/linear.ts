import { LinearClient } from "@linear/sdk";
import { getEnv, getTeamFilter } from "./config";
import { getCurrentStateTimesForActiveIssues } from "./db";

let client: LinearClient | null = null;

export function getLinearClient(): LinearClient {
  if (!client) {
    client = new LinearClient({ apiKey: getEnv("LINEAR_API_KEY") });
  }
  return client;
}

export interface UserWipIssue {
  identifier: string;
  title: string;
  url: string;
  state: string;
  teamName: string;
  /** How long the issue has been in its current state (human-readable) */
  duration: string | null;
}

export interface UserWipCount {
  userName: string;
  userId: string;
  inProgress: number;
  inReview: number;
  total: number;
  issues: UserWipIssue[];
}

export async function getWipCounts(): Promise<UserWipCount[]> {
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

  // Pre-fetch all active issue durations from DB in one query
  let activeIssueTimes: Map<string, { stateName: string; enteredAt: Date }>;
  try {
    activeIssueTimes = await getCurrentStateTimesForActiveIssues();
  } catch {
    activeIssueTimes = new Map(); // Fall back to per-issue Linear API calls
  }

  // Collect all WIP issues across teams, keyed by user
  const userMap = new Map<string, UserWipCount>();
  const unassignedKey = "__unassigned__";

  for (const team of teams) {
    const states = await team.states();
    const wipStates = states.nodes.filter((s) => s.type === "started");

    for (const state of wipStates) {
      const issues = await linear.issues({
        filter: {
          team: { id: { eq: team.id } },
          state: { id: { eq: state.id } },
        },
      });

      for (const issue of issues.nodes) {
        const assignee = await issue.assignee;
        const isReview = state.name.toLowerCase().includes("review");

        const key = assignee?.id ?? unassignedKey;
        const name = assignee?.name ?? "Unassigned";

        if (!userMap.has(key)) {
          userMap.set(key, {
            userName: name,
            userId: key,
            inProgress: 0,
            inReview: 0,
            total: 0,
            issues: [],
          });
        }

        // Calculate how long the issue has been in its current state
        let duration: string | null = null;
        const dbEntry = activeIssueTimes.get(issue.id);
        if (dbEntry) {
          const timeMs = Date.now() - dbEntry.enteredAt.getTime();
          if (timeMs > 0) {
            duration = formatDuration(timeMs);
          }
        } else {
          // Fallback to Linear API for issues without DB data
          try {
            const timeMs = await getTimeInState(issue.id, state.name);
            if (timeMs !== null && timeMs > 0) {
              duration = formatDuration(timeMs);
            }
          } catch {
            // Non-critical
          }
        }

        const entry = userMap.get(key)!;
        if (isReview) {
          entry.inReview += 1;
        } else {
          entry.inProgress += 1;
        }
        entry.total += 1;
        entry.issues.push({
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          state: state.name,
          teamName: team.name,
          duration,
        });
      }
    }
  }

  // Sort: real users first (by total desc), unassigned last
  const results = Array.from(userMap.values()).sort((a, b) => {
    if (a.userId === unassignedKey) return 1;
    if (b.userId === unassignedKey) return -1;
    return b.total - a.total;
  });

  return results;
}

/**
 * Get the time an issue spent in a given state by looking at issue history.
 * Returns duration in milliseconds, or null if no transition found.
 */
export async function getTimeInState(
  issueId: string,
  stateName: string
): Promise<number | null> {
  const linear = getLinearClient();
  const issue = await linear.issue(issueId);
  const history = await issue.history();

  // Find when the issue entered the target state (most recent first)
  let enteredAt: Date | null = null;
  let exitedAt: Date | null = null;

  // History is newest first — we want the most recent entry into stateName
  const sorted = [...history.nodes].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  for (const event of sorted) {
    const toState = await event.toState;
    const fromState = await event.fromState;

    if (toState?.name === stateName) {
      enteredAt = new Date(event.createdAt);
      exitedAt = null; // reset — we're looking for the latest pair
    } else if (fromState?.name === stateName) {
      exitedAt = new Date(event.createdAt);
    }
  }

  if (!enteredAt) return null;

  // If no exit yet, use now
  const end = exitedAt ?? new Date();
  return end.getTime() - enteredAt.getTime();
}

/**
 * Get the time since an issue first entered "In Progress".
 * Useful for measuring total cycle time from start of work to review/done.
 * Returns duration in milliseconds, or null if never was In Progress.
 */
export async function getTimeSinceInProgress(
  issueId: string
): Promise<number | null> {
  const linear = getLinearClient();
  const issue = await linear.issue(issueId);
  const history = await issue.history();

  const sorted = [...history.nodes].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  // Find the first time issue entered "In Progress"
  let startedAt: Date | null = null;
  for (const event of sorted) {
    const toState = await event.toState;
    if (toState?.name === "In Progress") {
      startedAt = new Date(event.createdAt);
      break; // use the first entry into In Progress
    }
  }

  if (!startedAt) return null;
  return Date.now() - startedAt.getTime();
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const totalHours = Math.floor(totalMinutes / 60);
  const totalDays = Math.floor(totalHours / 24);

  if (totalDays > 0) {
    const hours = totalHours % 24;
    return hours > 0 ? `${totalDays}d ${hours}h` : `${totalDays}d`;
  }
  if (totalHours > 0) {
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
  }
  return `${totalMinutes}m`;
}
