/**
 * Formatting utility functions for dates, durations, and other display values.
 */

/**
 * Format a date string to a localized string representation.
 * Returns 'Never' if the date is null or undefined.
 */
export function formatDate(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleString();
}

/**
 * Format a date string to a localized date (no time).
 * Returns 'Never' if the date is null or undefined.
 */
export function formatDateOnly(dateString: string | null | undefined): string {
  if (!dateString) return 'Never';
  return new Date(dateString).toLocaleDateString();
}

/**
 * Format duration in seconds to a human-readable string.
 * Examples: "45m", "1h 30m", "2h 0m"
 */
export function formatDuration(seconds: string | number): string {
  const totalSeconds =
    typeof seconds === 'string' ? parseInt(seconds, 10) : seconds;
  if (isNaN(totalSeconds)) return '—';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Truncate a UUID to show only the first 8 characters.
 */
export function truncateId(id: string, length = 8): string {
  if (!id) return '—';
  return `${id.slice(0, length)}...`;
}
