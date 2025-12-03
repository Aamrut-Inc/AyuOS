import { apiClient } from '../client';
import type { WorkoutStatisticResponse, WorkoutResponse } from '../types';

export interface WorkoutsParams {
  start_date?: string;
  end_date?: string;
  limit?: number;
  offset?: number;
  sort_order?: 'asc' | 'desc';
  workout_type?: string;
  source_name?: string;
  min_duration?: number;
  max_duration?: number;
  sort_by?:
    | 'start_datetime'
    | 'end_datetime'
    | 'duration_seconds'
    | 'type'
    | 'source_name';
  [key: string]: string | number | undefined;
}

export const healthService = {
  /**
   * Get heart rate data for a user
   * GET /api/v1/users/{user_id}/heart-rate
   */
  async getHeartRate(userId: string): Promise<WorkoutStatisticResponse[]> {
    return apiClient.get<WorkoutStatisticResponse[]>(
      `/api/v1/users/${userId}/heart-rate`
    );
  },

  /**
   * Get workouts for a user
   * GET /api/v1/users/{user_id}/workouts
   */
  async getWorkouts(
    userId: string,
    params?: WorkoutsParams
  ): Promise<WorkoutResponse[]> {
    return apiClient.get<WorkoutResponse[]>(
      `/api/v1/users/${userId}/workouts`,
      { params }
    );
  },
};
