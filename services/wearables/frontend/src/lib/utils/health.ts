import type { WorkoutStatisticResponse } from '@/lib/api/types';

export interface HeartRateStats {
  values: number[];
  min: number | null;
  max: number | null;
  avg: number | null;
  count: number;
}

/**
 * Calculate heart rate statistics from workout statistics data.
 * Filters for heart rate type statistics and computes min, max, avg.
 */
export function calculateHeartRateStats(
  data: WorkoutStatisticResponse[] | undefined
): HeartRateStats {
  const defaultStats: HeartRateStats = {
    values: [],
    min: null,
    max: null,
    avg: null,
    count: 0,
  };

  if (!data || data.length === 0) {
    return defaultStats;
  }

  const stats = data.reduce(
    (acc, stat) => {
      // Check for heart rate type (case-insensitive)
      const isHeartRate =
        stat.type.toLowerCase() === 'heartrate' ||
        stat.type.toLowerCase() === 'heart_rate';

      if (!isHeartRate) return acc;

      if (stat.avg !== null) {
        acc.values.push(stat.avg);
      }
      if (stat.min !== null && (acc.min === null || stat.min < acc.min)) {
        acc.min = stat.min;
      }
      if (stat.max !== null && (acc.max === null || stat.max > acc.max)) {
        acc.max = stat.max;
      }

      return acc;
    },
    {
      values: [] as number[],
      min: null as number | null,
      max: null as number | null,
    }
  );

  const avg =
    stats.values.length > 0
      ? Math.round(
          stats.values.reduce((a, b) => a + b, 0) / stats.values.length
        )
      : null;

  return {
    ...stats,
    avg,
    count: stats.values.length,
  };
}
