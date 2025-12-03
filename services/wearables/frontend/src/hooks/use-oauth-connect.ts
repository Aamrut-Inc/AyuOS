import { useState, useCallback } from 'react';
import { API_CONFIG } from '@/lib/api/config';

export type OAuthConnectionState = 'idle' | 'connecting' | 'success' | 'error';

export interface UseOAuthConnectOptions {
  userId: string;
  redirectUri?: string;
  onSuccess?: (providerId: string) => void;
  onError?: (error: string) => void;
}

export interface UseOAuthConnectReturn {
  connectionState: OAuthConnectionState;
  connectingProvider: string | null;
  error: string | null;
  connect: (providerId: string) => Promise<void>;
  reset: () => void;
}

/**
 * Hook for handling OAuth connection flow to wearable providers.
 * Calls the backend authorize endpoint and redirects to provider's OAuth page.
 */
export function useOAuthConnect(
  options: UseOAuthConnectOptions
): UseOAuthConnectReturn {
  const { userId, redirectUri, onSuccess, onError } = options;

  const [connectionState, setConnectionState] =
    useState<OAuthConnectionState>('idle');
  const [connectingProvider, setConnectingProvider] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(
    async (providerId: string) => {
      setConnectingProvider(providerId);
      setConnectionState('connecting');
      setError(null);

      try {
        const finalRedirectUri =
          redirectUri ||
          `${window.location.origin}/users/${userId}/pair/success?provider=${providerId}`;

        const params = new URLSearchParams({
          user_id: userId,
          redirect_uri: finalRedirectUri,
        });

        const response = await fetch(
          `${API_CONFIG.baseUrl}/api/v1/oauth/${providerId}/authorize?${params}`
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.detail ||
              errorData.message ||
              'Failed to get authorization URL'
          );
        }

        const data = await response.json();

        onSuccess?.(providerId);

        window.location.href = data.authorization_url;
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : 'Connection failed';
        setError(errorMessage);
        setConnectionState('error');
        setConnectingProvider(null);
        onError?.(errorMessage);
      }
    },
    [userId, redirectUri, onSuccess, onError]
  );

  const reset = useCallback(() => {
    setConnectionState('idle');
    setConnectingProvider(null);
    setError(null);
  }, []);

  return {
    connectionState,
    connectingProvider,
    error,
    connect,
    reset,
  };
}
