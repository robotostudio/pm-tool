import { sql } from "@vercel/postgres";

/**
 * Record a state transition event for an issue.
 */
export async function recordTransition(params: {
  issueId: string;
  identifier: string;
  fromState: string | null;
  toState: string;
  assigneeName?: string | null;
  transitionedAt?: Date;
}): Promise<void> {
  const ts = params.transitionedAt ?? new Date();
  await sql`
    INSERT INTO state_transitions (issue_id, identifier, from_state, to_state, assignee_name, transitioned_at)
    VALUES (${params.issueId}, ${params.identifier}, ${params.fromState}, ${params.toState}, ${params.assigneeName ?? null}, ${ts.toISOString()})
  `;
}

interface TransitionRow {
  from_state: string | null;
  to_state: string;
  transitioned_at: Date;
}

/**
 * Get all transitions for an issue, ordered chronologically.
 */
export async function getTransitionsForIssue(issueId: string): Promise<TransitionRow[]> {
  const { rows } = await sql`
    SELECT from_state, to_state, transitioned_at
    FROM state_transitions
    WHERE issue_id = ${issueId}
    ORDER BY transitioned_at ASC
  `;
  return rows as TransitionRow[];
}

/**
 * Compute how long an issue spent in a given state (most recent interval).
 * Returns milliseconds or null if the issue was never in that state.
 */
export async function getTimeInStateFromDb(
  issueId: string,
  stateName: string
): Promise<number | null> {
  const transitions = await getTransitionsForIssue(issueId);

  let enteredAt: Date | null = null;
  let exitedAt: Date | null = null;

  for (const row of transitions) {
    if (row.to_state === stateName) {
      enteredAt = new Date(row.transitioned_at);
      exitedAt = null; // reset — looking for latest pair
    } else if (row.from_state === stateName) {
      exitedAt = new Date(row.transitioned_at);
    }
  }

  if (!enteredAt) return null;

  const end = exitedAt ?? new Date();
  return end.getTime() - enteredAt.getTime();
}

/**
 * Get time since the issue first entered "In Progress".
 * Returns milliseconds or null if never was In Progress.
 */
export async function getTimeSinceInProgressFromDb(
  issueId: string
): Promise<number | null> {
  const { rows } = await sql`
    SELECT transitioned_at
    FROM state_transitions
    WHERE issue_id = ${issueId} AND to_state = 'In Progress'
    ORDER BY transitioned_at ASC
    LIMIT 1
  `;

  if (rows.length === 0) return null;

  const startedAt = new Date(rows[0].transitioned_at);
  return Date.now() - startedAt.getTime();
}

/**
 * Batch query: for all issues currently in a "started" state,
 * get when they entered that state. Returns map of issueId -> { stateName, enteredAt }.
 * Uses the most recent transition into a started state per issue.
 */
export async function getCurrentStateTimesForActiveIssues(): Promise<
  Map<string, { stateName: string; enteredAt: Date }>
> {
  const { rows } = await sql`
    SELECT DISTINCT ON (issue_id) issue_id, to_state, transitioned_at
    FROM state_transitions
    WHERE to_state IN ('In Progress', 'In Review')
    ORDER BY issue_id, transitioned_at DESC
  `;

  const map = new Map<string, { stateName: string; enteredAt: Date }>();
  for (const row of rows) {
    map.set(row.issue_id, {
      stateName: row.to_state,
      enteredAt: new Date(row.transitioned_at),
    });
  }
  return map;
}

export interface IssueTimeReport {
  issueId: string;
  identifier: string;
  assignee: string | null;
  inProgressMs: number;
  inReviewMs: number;
  totalMs: number;
}

/**
 * Get time spent per issue within a date range.
 * Handles intervals that started before `from` or haven't ended by `to`.
 * Optionally filter by identifier prefix (team key, e.g. "ROB").
 */
export async function getTimeReport(params: {
  from: Date;
  to: Date;
  team?: string;
}): Promise<IssueTimeReport[]> {
  const { from, to } = params;

  // Get all issues that had any transition touching this period
  // We need transitions before `from` too (to know the state at period start)
  let result;
  if (params.team) {
    const prefix = `${params.team.toUpperCase()}-`;
    result = await sql`
      SELECT issue_id, identifier, from_state, to_state, assignee_name, transitioned_at
      FROM state_transitions
      WHERE identifier LIKE ${prefix + "%"}
      ORDER BY issue_id, transitioned_at ASC
    `;
  } else {
    result = await sql`
      SELECT issue_id, identifier, from_state, to_state, assignee_name, transitioned_at
      FROM state_transitions
      ORDER BY issue_id, transitioned_at ASC
    `;
  }

  // Group transitions by issue, track latest assignee
  const byIssue = new Map<string, { identifier: string; assignee: string | null; transitions: TransitionRow[] }>();
  for (const row of result.rows) {
    const entry = byIssue.get(row.issue_id);
    if (entry) {
      entry.transitions.push(row as TransitionRow);
      if (row.assignee_name) entry.assignee = row.assignee_name;
    } else {
      byIssue.set(row.issue_id, {
        identifier: row.identifier,
        assignee: row.assignee_name ?? null,
        transitions: [row as TransitionRow],
      });
    }
  }

  const reports: IssueTimeReport[] = [];

  for (const [issueId, { identifier, assignee, transitions }] of byIssue) {
    const inProgressMs = sumTimeInState(transitions, "In Progress", from, to);
    const inReviewMs = sumTimeInState(transitions, "In Review", from, to);
    const totalMs = inProgressMs + inReviewMs;

    if (totalMs > 0) {
      reports.push({ issueId, identifier, assignee, inProgressMs, inReviewMs, totalMs });
    }
  }

  // Sort by total time descending
  reports.sort((a, b) => b.totalMs - a.totalMs);
  return reports;
}

/**
 * Sum time an issue spent in a given state, clipped to [from, to].
 */
function sumTimeInState(
  transitions: TransitionRow[],
  stateName: string,
  from: Date,
  to: Date
): number {
  let total = 0;
  let enteredAt: Date | null = null;

  for (const t of transitions) {
    if (t.to_state === stateName) {
      enteredAt = new Date(t.transitioned_at);
    } else if (t.from_state === stateName && enteredAt) {
      const exitedAt = new Date(t.transitioned_at);
      total += clippedDuration(enteredAt, exitedAt, from, to);
      enteredAt = null;
    }
  }

  // If still in this state, clip to `to`
  if (enteredAt) {
    const end = to < new Date() ? to : new Date();
    total += clippedDuration(enteredAt, end, from, to);
  }

  return total;
}

/** Clip an interval [start, end] to [from, to] and return duration in ms. */
function clippedDuration(start: Date, end: Date, from: Date, to: Date): number {
  const clippedStart = start < from ? from : start;
  const clippedEnd = end > to ? to : end;
  return Math.max(0, clippedEnd.getTime() - clippedStart.getTime());
}
