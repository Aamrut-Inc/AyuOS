import type { SQL } from "bun";
import { addDays } from "./timezone";
import { formatDay, type TimeRange } from "./time-phrases";

// "Last night" (5.4): the latest main sleep whose local end falls on today;
// if none, yesterday. Both providers label a night with the day the person
// woke up (Oura's `day`; Whoop's local wake date in v_sleep_sessions), so the
// result is that provider day.
export async function resolveLastNight(ro: SQL, today: string): Promise<{ day: string; found: boolean }> {
  const [row] = await ro`
    SELECT day::text AS day FROM agent.v_sleep_nights
    WHERE end_local::date = ${today}::date
    ORDER BY end_utc DESC LIMIT 1
  `;
  if (row) return { day: row.day, found: true };
  return { day: addDays(today, -1), found: false };
}

export async function settleLastNight(ro: SQL, ranges: TimeRange[], today: string): Promise<void> {
  for (const r of ranges) {
    if (!r.needsSleepLookup) continue;
    const night = await resolveLastNight(ro, today);
    r.from = night.day;
    r.to = night.day;
    r.label = night.found
      ? `last night (the sleep that ended on ${formatDay(night.day)})`
      : `last night (no sleep recorded ending today, so the night labelled ${formatDay(night.day)})`;
    delete r.needsSleepLookup;
  }
}
