import { apiClient } from '../client';
import { API_ENDPOINTS } from '../config';
import type { ApiKey, ApiKeyCreate } from '../types';

export const credentialsService = {
  async getApiKeys(): Promise<ApiKey[]> {
    return apiClient.get<ApiKey[]>(API_ENDPOINTS.apiKeys);
  },

  async getApiKey(id: string): Promise<ApiKey> {
    return apiClient.get<ApiKey>(API_ENDPOINTS.apiKeyDetail(id));
  },

  async createApiKey(data: ApiKeyCreate): Promise<ApiKey> {
    return apiClient.post<ApiKey>(API_ENDPOINTS.apiKeys, data);
  },

  async revokeApiKey(id: string): Promise<void> {
    return apiClient.delete<void>(API_ENDPOINTS.apiKeyDetail(id));
  },

  async deleteApiKey(id: string): Promise<void> {
    return apiClient.delete<void>(API_ENDPOINTS.apiKeyDetail(id));
  },
};
