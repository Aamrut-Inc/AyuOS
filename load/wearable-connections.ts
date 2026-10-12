import { SQL } from "bun";
import type { PostgresConfig } from "./config";
import { decryptSecret, encryptSecret } from "../shared/crypto";
import type { WearableProvider } from "../extract/wearables/providers";
import { ReconnectRequiredError, refreshTokens, type TokenSet } from "../extract/wearables/oauth";

export interface WearableConnection {
  provider: WearableProvider;
  status: "active" | "needs_reconnect";
  connectedAt: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}

// Refresh this long before expiry, so a token never expires mid-sync.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class WearableConnectionStore {
  readonly sql: SQL;

  constructor(config: PostgresConfig) {
    this.sql = new SQL(config.connectionString);
  }

  async list(): Promise<WearableConnection[]> {
    const rows = await this.sql`SELECT * FROM ops.wearable_connections ORDER BY provider`;
    return rows.map((r: any) => ({
      provider: r.provider,
      status: r.status,
      connectedAt: new Date(r.connected_at).toISOString(),
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
      lastError: r.last_error
    }));
  }

  async save(provider: WearableProvider, tokens: TokenSet, providerUserId: string | null = null): Promise<void> {
    await this.sql`
      INSERT INTO ops.wearable_connections (
        provider, access_token_enc, refresh_token_enc, token_expires_at, scope, provider_user_id, status, connected_at, last_error
      ) VALUES (
        ${provider}, ${encryptSecret(tokens.accessToken)},
        ${tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null},
        ${tokens.expiresAt}, ${tokens.scope}, ${providerUserId}, 'active', now(), NULL
      )
      ON CONFLICT (provider) DO UPDATE SET
        access_token_enc = EXCLUDED.access_token_enc,
        refresh_token_enc = coalesce(EXCLUDED.refresh_token_enc, ops.wearable_connections.refresh_token_enc),
        token_expires_at = EXCLUDED.token_expires_at,
        scope = coalesce(EXCLUDED.scope, ops.wearable_connections.scope),
        provider_user_id = coalesce(EXCLUDED.provider_user_id, ops.wearable_connections.provider_user_id),
        status = 'active',
        last_error = NULL
    `;
  }

  // A valid access token, refreshed first if it's about to expire. The row is
  // locked while refreshing: providers rotate refresh tokens and revoke the
  // whole login if one is replayed, so two syncs must never refresh with the
  // same token. `force` refreshes even if not expired (after a 401).
  async accessToken(provider: WearableProvider, force = false): Promise<string> {
    // The transaction returns the outcome instead of throwing for a refused
    // refresh: throwing inside begin() would roll back the needs_reconnect
    // marker along with everything else.
    const outcome = await this.sql.begin(async (tx) => {
      const [row] = await tx`SELECT * FROM ops.wearable_connections WHERE provider = ${provider} FOR UPDATE`;
      if (!row) return { reconnect: `${provider} isn't connected` };
      if (row.status === "needs_reconnect") return { reconnect: `${provider} needs to be reconnected` };

      const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : Infinity;
      if (!force && expiresAt - Date.now() > REFRESH_MARGIN_MS) return { token: decryptSecret(row.access_token_enc) };
      if (!row.refresh_token_enc) return { dead: `${provider} login expired and can't be renewed` };

      // The refresh call stays inside the lock so no other sync can replay
      // the same refresh token. If the provider rotates it but this UPDATE or
      // the commit then fails, the new token is lost and the login with it —
      // unavoidable without the provider supporting idempotent refreshes.
      let tokens: TokenSet;
      try {
        tokens = await refreshTokens(provider, decryptSecret(row.refresh_token_enc));
      } catch (error) {
        if (error instanceof ReconnectRequiredError) return { dead: error.message };
        throw error;
      }
      await tx`
        UPDATE ops.wearable_connections SET
          access_token_enc = ${encryptSecret(tokens.accessToken)},
          refresh_token_enc = ${tokens.refreshToken ? encryptSecret(tokens.refreshToken) : row.refresh_token_enc},
          token_expires_at = ${tokens.expiresAt},
          last_error = NULL
        WHERE provider = ${provider}
      `;
      return { token: tokens.accessToken };
    });

    if ("token" in outcome) return outcome.token!;
    if ("dead" in outcome) {
      await this.sql`
        UPDATE ops.wearable_connections SET status = 'needs_reconnect', last_error = ${outcome.dead}
        WHERE provider = ${provider}
      `;
      throw new ReconnectRequiredError(outcome.dead!);
    }
    throw new ReconnectRequiredError(outcome.reconnect!);
  }

  async lastSyncedAt(provider: WearableProvider): Promise<Date | null> {
    const [row] = await this.sql`SELECT last_synced_at FROM ops.wearable_connections WHERE provider = ${provider}`;
    return row?.last_synced_at ? new Date(row.last_synced_at) : null;
  }

  async markSynced(provider: WearableProvider, at: Date): Promise<void> {
    await this.sql`
      UPDATE ops.wearable_connections SET last_synced_at = ${at}, last_error = NULL WHERE provider = ${provider}
    `;
  }

  async recordError(provider: WearableProvider, message: string): Promise<void> {
    await this.sql`UPDATE ops.wearable_connections SET last_error = ${message} WHERE provider = ${provider}`;
  }

  async remove(provider: WearableProvider): Promise<void> {
    await this.sql`DELETE FROM ops.wearable_connections WHERE provider = ${provider}`;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }
}
