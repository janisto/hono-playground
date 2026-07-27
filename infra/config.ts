export const STACK_NAME = "HonoPlayground";
// Keep at the newest date supported by every pinned runtime; see AGENTS.md.
export const COMPATIBILITY_DATE = "2026-07-11";
export const MIGRATIONS_TABLE = "drizzle_migrations";
export const WORKER_BASE_NAME = "hono-playground";

export const isRateLimitNamespaceId = (value: string): boolean => /^[1-9][0-9]*$/u.test(value);

export const RATE_LIMITS = {
  public: { limit: 300, period: 60 },
  profileRead: { limit: 120, period: 60 },
  profileWrite: { limit: 30, period: 60 },
} as const;
