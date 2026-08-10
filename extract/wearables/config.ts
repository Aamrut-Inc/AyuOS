export interface WearablesConfig {
  apiBaseUrl: string;
  apiKey: string;
  userId: string | null;
  syncDays: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadWearablesConfig(): WearablesConfig {
  const syncDaysRaw = process.env.WEARABLE_SYNC_DAYS?.trim();
  return {
    apiBaseUrl: requiredEnv("OPEN_WEARABLES_API_BASE_URL").replace(/\/$/, ""),
    apiKey: requiredEnv("OPEN_WEARABLES_API_KEY"),
    userId: process.env.OPEN_WEARABLES_USER_ID?.trim() || null,
    syncDays: syncDaysRaw ? Number(syncDaysRaw) : 90
  };
}

export function requireUserId(config: WearablesConfig): string {
  if (!config.userId) {
    throw new Error(
      "OPEN_WEARABLES_USER_ID is not set. Run cli/connect-wearables.ts first, " +
        "or call getOrCreateUserId()."
    );
  }
  return config.userId;
}
