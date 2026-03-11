export interface ParsedQuery {
  team?: string;
  from?: string; // ISO date string
  to?: string; // ISO date string
  assignee?: string; // partial name match
}

const MONTH_MAP: Record<string, number> = {
  january: 0, jan: 0,
  february: 1, feb: 1,
  march: 2, mar: 2,
  april: 3, apr: 3,
  may: 4,
  june: 5, jun: 5,
  july: 6, jul: 6,
  august: 7, aug: 7,
  september: 8, sep: 8, sept: 8,
  october: 9, oct: 9,
  november: 10, nov: 10,
  december: 11, dec: 11,
};

/**
 * Parse a natural language query like:
 *   "time on ROB in february"
 *   "ROB last week by John"
 *   "TRA from 2025-02-01 to 2025-02-28"
 *   "time in march"
 */
export function parseQuery(text: string): ParsedQuery {
  const result: ParsedQuery = {};
  const lower = text.toLowerCase().trim();

  // Extract team key: "on ROB", "for TRA", or bare uppercase 2-4 letter code
  const teamMatch =
    lower.match(/(?:on|for)\s+([a-z]{2,5})\b/) ||
    text.match(/\b([A-Z]{2,5})\b/);
  if (teamMatch) {
    result.team = teamMatch[1].toUpperCase();
  }

  // Extract assignee: "by John", "assigned to Jane Smith"
  const assigneeMatch = lower.match(/(?:by|assigned\s+to)\s+([a-z][a-z\s]+?)(?:\s+(?:in|on|for|from|last|this)|$)/);
  if (assigneeMatch) {
    result.assignee = assigneeMatch[1].trim();
  }

  // Extract explicit date range: "from YYYY-MM-DD to YYYY-MM-DD"
  const explicitRange = lower.match(/from\s+(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/);
  if (explicitRange) {
    result.from = explicitRange[1];
    result.to = explicitRange[2];
    return result;
  }

  const now = new Date();

  // "last week"
  if (lower.includes("last week")) {
    const lastMonday = new Date(now);
    const dayOfWeek = lastMonday.getDay();
    const daysToLastMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    lastMonday.setDate(lastMonday.getDate() - daysToLastMonday - 7);
    lastMonday.setHours(0, 0, 0, 0);

    const lastSunday = new Date(lastMonday);
    lastSunday.setDate(lastSunday.getDate() + 7);

    result.from = toISODate(lastMonday);
    result.to = toISODate(lastSunday);
    return result;
  }

  // "this week"
  if (lower.includes("this week")) {
    const thisMonday = new Date(now);
    const dayOfWeek = thisMonday.getDay();
    const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    thisMonday.setDate(thisMonday.getDate() - daysToMonday);
    thisMonday.setHours(0, 0, 0, 0);

    result.from = toISODate(thisMonday);
    result.to = toISODate(now);
    return result;
  }

  // "last month"
  if (lower.includes("last month")) {
    const firstOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    result.from = toISODate(firstOfLastMonth);
    result.to = toISODate(firstOfThisMonth);
    return result;
  }

  // "this month"
  if (lower.includes("this month")) {
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    result.from = toISODate(firstOfMonth);
    result.to = toISODate(now);
    return result;
  }

  // "in february", "in feb", "in march 2025"
  const monthMatch = lower.match(/in\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(\d{4}))?/);
  if (monthMatch) {
    const monthIndex = MONTH_MAP[monthMatch[1]];
    const year = monthMatch[2] ? parseInt(monthMatch[2], 10) : inferYear(monthIndex, now);
    const firstOfMonth = new Date(year, monthIndex, 1);
    const firstOfNextMonth = new Date(year, monthIndex + 1, 1);
    result.from = toISODate(firstOfMonth);
    result.to = toISODate(firstOfNextMonth);
    return result;
  }

  // Default: last 30 days
  if (!result.from && !result.to) {
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    result.from = toISODate(thirtyDaysAgo);
    result.to = toISODate(now);
  }

  return result;
}

/** If no year specified, pick the most recent occurrence of that month */
function inferYear(monthIndex: number, now: Date): number {
  if (monthIndex <= now.getMonth()) {
    return now.getFullYear();
  }
  return now.getFullYear() - 1;
}

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}
