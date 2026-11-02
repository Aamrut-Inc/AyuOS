// Time zone arithmetic shared by the offset-history job and the context
// builder. Offsets are minutes east of UTC (+330 for Asia/Kolkata).

export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// The zone's UTC offset at an instant, in minutes.
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

// Local wall-clock parts of an instant in a zone.
export function localParts(zone: string, at: Date): { date: string; time: string; weekday: number } {
  const shifted = new Date(at.getTime() + zoneOffsetMinutes(zone, at) * 60000);
  const iso = shifted.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: shifted.getUTCDay() };
}

// The UTC instant at which a local date's midnight starts in a zone.
export function localMidnightUtc(zone: string, date: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  // Two passes settle the offset even when midnight is near a DST change.
  let instant = new Date(guess.getTime() - zoneOffsetMinutes(zone, guess) * 60000);
  instant = new Date(guess.getTime() - zoneOffsetMinutes(zone, instant) * 60000);
  return instant;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export interface OffsetObservation {
  at: Date;
  offsetMinutes: number;
}

export interface OffsetInterval {
  validFrom: Date | null; // null = from the beginning of time
  validTo: Date | null; // null = open-ended
  offsetMinutes: number;
  ianaTz: string | null;
  source: string;
  observations: number;
}

const FLIP_FLOP_MIN_SPAN_MS = 12 * 60 * 60 * 1000;

// Section 5.2: sort, merge consecutive same-offset observations into runs,
// ignore flip-flops (a run needs 2 observations or 12 hours), carry offsets
// across gaps, use the earliest offset before the first observation and the
// current zone after the last one, and tag intervals that match the current
// IANA zone so its daylight-saving rules apply inside them.
export function buildOffsetIntervals(observations: OffsetObservation[], currentZone: string, now = new Date()): OffsetInterval[] {
  const sorted = [...observations].sort((a, b) => a.at.getTime() - b.at.getTime());
  if (sorted.length === 0) {
    return [{ validFrom: null, validTo: null, offsetMinutes: zoneOffsetMinutes(currentZone, now), ianaTz: currentZone, source: "current_zone", observations: 0 }];
  }

  // A zone with daylight saving has two offsets; observations matching either
  // at their own instant belong to it and must not split into intervals.
  const key = (o: OffsetObservation) =>
    o.offsetMinutes === zoneOffsetMinutes(currentZone, o.at) ? `zone:${currentZone}` : `off:${o.offsetMinutes}`;

  type Run = { key: string; first: Date; last: Date; count: number; offset: number };
  const runs: Run[] = [];
  for (const o of sorted) {
    const k = key(o);
    const run = runs.at(-1);
    if (run && run.key === k) {
      run.last = o.at;
      run.count += 1;
    } else {
      runs.push({ key: k, first: o.at, last: o.at, count: 1, offset: o.offsetMinutes });
    }
  }

  const accepted: Run[] = [];
  for (const run of runs) {
    const supported = run.count >= 2 || run.last.getTime() - run.first.getTime() >= FLIP_FLOP_MIN_SPAN_MS;
    const prev = accepted.at(-1);
    if (!supported && prev) {
      prev.last = run.last;
      prev.count += run.count;
      continue;
    }
    if (prev && prev.key === run.key) {
      prev.last = run.last;
      prev.count += run.count;
    } else {
      accepted.push({ ...run });
    }
  }

  const intervals: OffsetInterval[] = accepted.map((run, i) => ({
    validFrom: i === 0 ? null : run.first,
    validTo: i + 1 < accepted.length ? accepted[i + 1]!.first : null,
    offsetMinutes: run.offset,
    ianaTz: run.key.startsWith("zone:") ? currentZone : null,
    source: "wearable_records",
    observations: run.count
  }));

  // After the last observation, the Mac's current zone applies.
  const last = intervals.at(-1)!;
  const lastObservation = accepted.at(-1)!.last;
  if (last.ianaTz !== currentZone) {
    last.validTo = new Date(lastObservation.getTime() + 1);
    intervals.push({
      validFrom: last.validTo,
      validTo: null,
      offsetMinutes: zoneOffsetMinutes(currentZone, now),
      ianaTz: currentZone,
      source: "current_zone",
      observations: 0
    });
  }
  return intervals;
}
