import type { SQL } from "bun";
import { buildOffsetIntervals, isValidTimeZone, systemTimeZone, zoneOffsetMinutes, type OffsetObservation } from "../context/timezone";

// Rebuilds agent.tz_history from the UTC offsets that survive inside the
// wearable documents (handbook §6.4, Q31). Paths confirmed against the live
// data on 2026-11-01:
//   Oura  sleep.bedtime_start / bedtime_end, workout.start_datetime,
//         session.start_datetime                       ("...-07:00")
//   Whoop cycle / sleep / workout .timezone_offset     ("+05:30")
// Day-label timestamps are not used: Oura daily_sleep/readiness sit at UTC
// midnight, and daily_activity.timestamp is the nominal 04:00 local start of
// the day, which after an eastward flight lies before the flight itself.
export const OFFSET_SOURCES_SQL = `
  SELECT start_time AS at, agent._iso_offset_minutes(json ->> 'bedtime_start') AS offset_minutes
  FROM wearables.records WHERE provider = 'oura' AND data_type = 'sleep' AND is_current
  UNION ALL
  SELECT end_time, agent._iso_offset_minutes(json ->> 'bedtime_end')
  FROM wearables.records WHERE provider = 'oura' AND data_type = 'sleep' AND is_current

  UNION ALL
  SELECT (json ->> 'start_datetime')::timestamptz, agent._iso_offset_minutes(json ->> 'start_datetime')
  FROM wearables.records WHERE provider = 'oura' AND data_type IN ('workout', 'session') AND is_current
  UNION ALL
  SELECT start_time, agent._offset_minutes(json ->> 'timezone_offset')
  FROM wearables.records WHERE provider = 'whoop' AND data_type IN ('cycle', 'sleep', 'workout') AND is_current
  UNION ALL
  SELECT end_time, agent._offset_minutes(json ->> 'timezone_offset')
  FROM wearables.records WHERE provider = 'whoop' AND data_type = 'sleep' AND is_current
`;

export async function currentZone(main: SQL): Promise<string> {
  const [row] = await main`SELECT value #>> '{}' AS zone FROM agent.user_settings WHERE key = 'timezone'`;
  const zone = row?.zone;
  return zone && isValidTimeZone(zone) ? zone : systemTimeZone();
}

// Section 5.1: the Mac's zone is recorded at the start of every turn unless
// the person chose one (source = 'user' always wins).
export async function recordSystemZone(main: SQL, zone = systemTimeZone()): Promise<void> {
  await main`
    INSERT INTO agent.user_settings (key, value, source, updated_at)
    VALUES ('timezone', ${JSON.stringify(zone)}::text::jsonb, 'system', now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, source = 'system', updated_at = now()
    WHERE agent.user_settings.source <> 'user' AND agent.user_settings.value <> EXCLUDED.value
  `;
}

export async function loadOffsetObservations(main: SQL): Promise<OffsetObservation[]> {
  const rows = await main.unsafe(`SELECT at, offset_minutes FROM (${OFFSET_SOURCES_SQL}) s WHERE at IS NOT NULL AND offset_minutes IS NOT NULL`);
  return rows.map((r: any) => ({ at: new Date(r.at), offsetMinutes: Number(r.offset_minutes) }));
}

export async function rebuildTzHistory(main: SQL, now = new Date()): Promise<{ intervals: number; observations: number }> {
  const zone = await currentZone(main);
  const observations = await loadOffsetObservations(main);
  const intervals = buildOffsetIntervals(observations, zone, now);
  await main.begin(async (tx) => {
    await tx`DELETE FROM agent.tz_history`;
    for (const i of intervals) {
      await tx`
        INSERT INTO agent.tz_history (valid_from, valid_to, utc_offset_minutes, iana_tz, source, observations)
        VALUES (${i.validFrom ?? "-infinity"}, ${i.validTo}, ${i.offsetMinutes}, ${i.ianaTz}, ${i.source}, ${i.observations})
      `;
    }
  });
  return { intervals: intervals.length, observations: observations.length };
}

// Section 5.5: the latest provider offset and the Mac's zone disagree for
// more than 48 hours (travelling without the laptop, or a wrong Mac zone).
export async function zoneDisagreement(main: SQL, now = new Date()): Promise<{ providerOffset: number; since: Date } | null> {
  const zone = await currentZone(main);
  const [source] = await main`SELECT source FROM agent.user_settings WHERE key = 'timezone'`;
  if (source?.source === "user") return null;
  const observations = (await loadOffsetObservations(main)).sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = observations[0];
  if (!latest) return null;
  if (latest.offsetMinutes === zoneOffsetMinutes(zone, latest.at)) return null;
  // Oldest consecutive observation (going back) with the same differing offset.
  let since = latest.at;
  for (const o of observations) {
    if (o.offsetMinutes !== latest.offsetMinutes) break;
    since = o.at;
  }
  return now.getTime() - since.getTime() > 48 * 3600 * 1000 ? { providerOffset: latest.offsetMinutes, since } : null;
}
