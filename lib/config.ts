export function getEnv(key: string, required = true): string {
  const val = process.env[key];
  if (!val && required) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return val ?? "";
}

export function getTeamFilter(): string[] {
  const raw = process.env.TEAM_FILTER ?? "";
  if (!raw.trim()) return [];
  return raw.split(",").map((s) => s.trim().toLowerCase());
}
