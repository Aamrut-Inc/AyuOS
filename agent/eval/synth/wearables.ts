import { addDays, zoneOffsetMinutes } from "../../context/timezone";
import { DAYS, END_DAY, type Persona } from "./personas";

// Oura- and Whoop-shaped API documents for one persona, with known patterns
// built in so the right answer to analysis questions is computable:
//   a resting-HR trend, a lag-1 link from short sleep to lower HRV the next
//   night, illness-like anomaly episodes, sync gaps, days the device wasn't
//   worn, naps, a trip that changes the UTC offset, the zone's own daylight
//   saving changes, an injury that cuts activity and recovers.
// The builder turns these into wearables.records and timeseries.readings with
// the app's own mappers (extract/wearables/oura.ts, whoop.ts).

export function rng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 3432918353), (h = (h << 13) | (h >>> 19));
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(r: () => number): number {
  return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
}

const round = (v: number, places = 0) => Math.round(v * 10 ** places) / 10 ** places;

export interface SyntheticWearables {
  oura: Record<string, any[]>;
  whoop: Record<string, any[]>;
  appleReadings: Array<{ metricType: string; ts: string; value: number; unit: string }>;
  // Per-day ground truth for the analysis question set.
  truth: Array<{ day: string; index: number; restingHr: number; hrv: number; sleepHours: number; steps: number; anomaly: boolean; gap: boolean; nonWear: boolean; offsetMinutes: number }>;
}

export const FIRST_DAY = addDays(END_DAY, -(DAYS - 1));

function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

// A local wall-clock time on a local date. The offset is resolved at the
// instant itself (two passes), so nights across a daylight-saving change get
// the offset a real device would report.
function at(date: string, hours: number, offsetAt: (utc: Date) => number) {
  const totalMin = Math.round(hours * 60);
  const dayShift = Math.floor(totalMin / 1440);
  const local = new Date(`${addDays(date, dayShift)}T00:00:00Z`);
  local.setUTCMinutes(totalMin - dayShift * 1440);
  let offsetMinutes = offsetAt(local);
  offsetMinutes = offsetAt(new Date(local.getTime() - offsetMinutes * 60000));
  const utc = new Date(local.getTime() - offsetMinutes * 60000);
  const localIso = `${local.toISOString().slice(0, 19)}.000${offsetLabel(offsetMinutes)}`;
  return { utc, localIso, utcIso: utc.toISOString(), offsetMinutes };
}

function stageString(r: () => number, slots: number): string {
  let out = "";
  for (let i = 0; i < slots; i++) {
    const phase = (i / slots) * 4.5; // ~4-5 cycles a night
    const inCycle = phase - Math.floor(phase);
    const deepShare = i < slots / 2 ? 0.35 : 0.1;
    const x = r();
    if (i === 0 || i === slots - 1 || x < 0.06) out += "4";
    else if (inCycle < deepShare) out += "1";
    else if (inCycle > 0.8) out += "3";
    else out += "2";
  }
  return out;
}

export function generateWearables(p: Persona): SyntheticWearables {
  const r = rng(`wearables-${p.id}`);
  const w = p.wearable;
  const oura: Record<string, any[]> = { daily_activity: [], daily_sleep: [], daily_readiness: [], daily_spo2: [], sleep: [], workout: [], heartrate: [], personal_info: [] };
  const whoop: Record<string, any[]> = { cycle: [], recovery: [], sleep: [], workout: [], profile: [], body_measurement: [] };
  const appleReadings: SyntheticWearables["appleReadings"] = [];
  const truth: SyntheticWearables["truth"] = [];
  const hasOura = p.providers.includes("oura");
  const hasWhoop = p.providers.includes("whoop");
  const hasApple = p.providers.includes("apple_health");
  // p01's Whoop login died a month before the end (T16: stale data).
  const whoopLastDay = p.id === "p01" ? DAYS - 32 : DAYS;

  let prevSleepHours = w.sleepHours;
  let prevWake: { utc: Date; localIso: string } | null = null;
  let prevCycleId: string | null = null;

  for (let i = 0; i < DAYS; i++) {
    const day = addDays(FIRST_DAY, i);
    const inTrip = w.trip && i >= w.trip.startDay && i < w.trip.startDay + w.trip.days;
    const offset = (utc: Date) => (inTrip ? w.trip!.offsetMinutes : zoneOffsetMinutes(p.tz, utc));
    const dayOffset = offset(new Date(`${day}T12:00:00Z`));
    // The first and last day of a trip are travel days without device data,
    // so observations from two zones never interleave.
    const travelDay = w.trip !== undefined && (i === w.trip.startDay || i === w.trip.startDay + w.trip.days);
    const gap = travelDay || w.gaps.some((g) => i >= g.startDay && i < g.startDay + g.days);
    const nonWear = w.nonWearDays.includes(i);
    const anomaly = w.anomalies.find((a) => i >= a.startDay && i < a.startDay + a.days);
    const injuryFactor = w.injury && i >= w.injury.day && i < w.injury.day + w.injury.days ? 0.3 + 0.7 * ((i - w.injury.day) / w.injury.days) : 1;

    const restingHr = w.restingHr + (w.restingHrTrendPerWeek * i) / 7 + (anomaly?.hrDelta ?? 0) + normal(r) * 1.2;
    const sleepHours = Math.max(4, w.sleepHours + (normal(r) * w.sleepSdMin) / 60 - (anomaly ? 0.4 : 0));
    // Lag-1: tonight's HRV falls when last night was short.
    const hrv = Math.max(12, w.hrvBase - w.hrvPerSleepHour * (w.sleepHours - prevSleepHours) - (anomaly ? 8 : 0) + normal(r) * 3);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    const steps = Math.max(300, Math.round((w.stepsBase * (weekday === 0 || weekday === 6 ? 0.85 : 1.05) * injuryFactor + normal(r) * 1200) * (nonWear ? 0.2 : 1)));
    const tempDev = round(normal(r) * 0.15 + (anomaly?.tempDelta ?? 0), 2);
    truth.push({ day, index: i, restingHr: round(restingHr, 1), hrv: round(hrv, 1), sleepHours: round(sleepHours, 2), steps, anomaly: Boolean(anomaly), gap, nonWear, offsetMinutes: dayOffset });

    if (gap) {
      prevSleepHours = sleepHours;
      continue;
    }

    // Night ending on the morning of `day` (both providers label it `day`).
    const bedHour = 23 + normal(r) * 0.5 - 24; // relative to `day` midnight
    const latencyMin = 8 + r() * 12;
    const awakeMin = 25 + r() * 25;
    const inBedMin = sleepHours * 60 + awakeMin + latencyMin;
    const bed = at(day, bedHour, offset);
    const wake = at(day, bedHour + inBedMin / 60, offset);
    const slots = Math.floor((inBedMin * 60) / 300);
    const stages = stageString(r, slots);
    const asleepS = Math.round(sleepHours * 3600);
    const deepS = Math.round(asleepS * (0.17 + r() * 0.04));
    const remS = Math.round(asleepS * (0.21 + r() * 0.04));
    const lightS = asleepS - deepS - remS;

    if (hasOura) {
      oura.sleep!.push({
        id: `oura-sleep-${p.id}-${i}`, day, type: "long_sleep", bedtime_start: bed.localIso, bedtime_end: wake.localIso,
        total_sleep_duration: asleepS, deep_sleep_duration: deepS, light_sleep_duration: lightS, rem_sleep_duration: remS,
        awake_time: Math.round(awakeMin * 60), time_in_bed: Math.round(inBedMin * 60), latency: Math.round(latencyMin * 60),
        efficiency: round((asleepS / (inBedMin * 60)) * 100), average_heart_rate: round(restingHr + 4, 1), lowest_heart_rate: Math.round(restingHr),
        average_hrv: Math.round(hrv), average_breath: round(14.5 + normal(r) * 0.6 + (anomaly ? 1.5 : 0), 1), restless_periods: Math.round(150 + r() * 80),
        sleep_phase_5_min: stages,
        heart_rate: nonWear ? null : { interval: 300, timestamp: bed.localIso, items: Array.from({ length: slots }, () => Math.round(restingHr + 3 + normal(r) * 2)) },
        hrv: nonWear ? null : { interval: 300, timestamp: bed.localIso, items: Array.from({ length: slots }, () => Math.max(8, Math.round(hrv + normal(r) * 6))) }
      });
      const napChance = w.napsPerWeek / 7;
      if (r() < napChance) {
        const napStart = at(day, 14 + r() * 2, offset);
        const napEnd = at(day, 14.6 + r() * 2, offset);
        if (napEnd.utc > napStart.utc) {
          const napS = Math.round((napEnd.utc.getTime() - napStart.utc.getTime()) / 1000);
          oura.sleep!.push({
            id: `oura-nap-${p.id}-${i}`, day, type: "late_nap", bedtime_start: napStart.localIso, bedtime_end: napEnd.localIso,
            total_sleep_duration: Math.round(napS * 0.85), deep_sleep_duration: 0, light_sleep_duration: Math.round(napS * 0.75), rem_sleep_duration: Math.round(napS * 0.1),
            awake_time: Math.round(napS * 0.15), time_in_bed: napS, latency: 300, efficiency: 85,
            average_heart_rate: round(restingHr + 8, 1), lowest_heart_rate: Math.round(restingHr + 3), average_hrv: Math.round(hrv - 5),
            sleep_phase_5_min: "2".repeat(Math.max(1, Math.floor(napS / 300)))
          });
        }
      }
      const sleepScore = Math.max(40, Math.min(98, Math.round(78 + (sleepHours - 7) * 9 + normal(r) * 4)));
      oura.daily_sleep!.push({ id: `oura-ds-${p.id}-${i}`, day, score: sleepScore, timestamp: `${day}T00:00:00+00:00`, contributors: { total_sleep: Math.min(100, Math.round(sleepHours * 13)), efficiency: 85, deep_sleep: 80, rem_sleep: 78, latency: 82, restfulness: 70, timing: 75 } });
      const readiness = Math.max(30, Math.min(99, Math.round(80 - (restingHr - w.restingHr) * 2.5 + (hrv - w.hrvBase) * 0.5 + normal(r) * 3)));
      oura.daily_readiness!.push({
        id: `oura-dr-${p.id}-${i}`, day, score: readiness, temperature_deviation: tempDev, temperature_trend_deviation: round(tempDev * 0.6, 2),
        timestamp: `${day}T00:00:00+00:00`,
        contributors: { activity_balance: 80, body_temperature: anomaly ? 55 : 92, hrv_balance: Math.round(70 + (hrv - w.hrvBase) / 2), previous_day_activity: 78, previous_night: Math.min(100, Math.round(sleepHours * 12)), recovery_index: 80, resting_heart_rate: Math.round(90 - (restingHr - w.restingHr) * 4), sleep_balance: 77, sleep_regularity: 81 }
      });
      oura.daily_spo2!.push({ id: `oura-spo2-${p.id}-${i}`, day, spo2_percentage: { average: round(97 + normal(r) * 0.5 - (anomaly && p.id === "p09" ? 3 : 0), 1) }, breathing_disturbance_index: Math.round(5 + r() * 6) });
      const nonWearS = nonWear ? 52000 + Math.round(r() * 8000) : Math.round(r() * 1800);
      const activityTs = at(day, 4, offset);
      oura.daily_activity!.push({
        id: `oura-da-${p.id}-${i}`, day, timestamp: activityTs.localIso, steps, active_calories: Math.round(steps * 0.045), total_calories: Math.round(2000 + steps * 0.045),
        equivalent_walking_distance: Math.round(steps * 0.76), score: Math.max(30, Math.min(99, Math.round(60 + steps / 400))), non_wear_time: nonWearS,
        high_activity_time: Math.round(steps / 30), medium_activity_time: Math.round(steps / 8), low_activity_time: Math.round(steps / 3), sedentary_time: 30000, resting_time: 28000,
        inactivity_alerts: Math.round(r() * 3), target_calories: 450, target_meters: 9000, meters_to_target: Math.max(0, 9000 - Math.round(steps * 0.76)),
        contributors: { meet_daily_targets: 80, move_every_hour: 75, recovery_time: 90, stay_active: 70, training_frequency: 80, training_volume: 75 },
        ...(p.id === "p01" ? { class_5_min: Array.from({ length: 288 }, (_, k) => (nonWear && k > 60 ? "0" : k < 84 ? "1" : String(2 + Math.floor(r() * 3)))).join("") } : {})
      });
    }

    // Workouts (fewer during an injury).
    const workouts: Array<{ start: ReturnType<typeof at>; end: ReturnType<typeof at>; sport: string; strain: number }> = [];
    if (!nonWear && r() < (w.workoutsPerWeek / 7) * injuryFactor) {
      const startHour = 17 + r() * 2;
      const minutes = 30 + Math.round(r() * 50);
      const sport = ["running", "cycling", "strengthTraining", "walking"][Math.floor(r() * 4)]!;
      workouts.push({ start: at(day, startHour, offset), end: at(day, startHour + minutes / 60, offset), sport, strain: round(8 + r() * 8, 1) });
    }
    for (const [k, wk] of workouts.entries()) {
      const minutes = (wk.end.utc.getTime() - wk.start.utc.getTime()) / 60000;
      if (hasOura) {
        oura.workout!.push({
          id: `oura-wo-${p.id}-${i}-${k}`, day, activity: wk.sport, calories: Math.round(minutes * 8), distance: wk.sport === "strengthTraining" ? null : Math.round(minutes * 150),
          intensity: wk.strain > 13 ? "hard" : wk.strain > 10 ? "moderate" : "easy", start_datetime: wk.start.localIso, end_datetime: wk.end.localIso, source: "autodetected", label: null
        });
      }
      if (hasWhoop && i < whoopLastDay) {
        whoop.workout!.push({
          id: `whoop-wo-${p.id}-${i}-${k}`, start: wk.start.utcIso, end: wk.end.utcIso, timezone_offset: offsetLabel(wk.start.offsetMinutes), sport_name: wk.sport, score_state: "SCORED",
          score: { strain: wk.strain, average_heart_rate: Math.round(restingHr + 70), max_heart_rate: Math.round(restingHr + 105), kilojoule: minutes * 35, percent_recorded: 100, distance_meter: Math.round(minutes * 150),
                   zone_durations: { zone_zero_milli: 60000, zone_one_milli: minutes * 12000, zone_two_milli: minutes * 20000, zone_three_milli: minutes * 18000, zone_four_milli: minutes * 8000, zone_five_milli: minutes * 2000 } }
        });
      }
    }

    // Daytime heart rate samples; the first 90 days have no `source`, like
    // readings written by the older backend (T15: context NULL).
    if (hasOura && !nonWear) {
      const wakeLocalHour = bedHour + inBedMin / 60;
      for (let h = wakeLocalHour; h < 22.5; h += p.hrIntervalMin / 60) {
        const t = at(day, h, offset);
        const inWorkout = workouts.some((wk) => t.utc >= wk.start.utc && t.utc < wk.end.utc);
        oura.heartrate!.push({ timestamp: t.utcIso, bpm: Math.round(restingHr + (inWorkout ? 75 : 18) + normal(r) * 5), ...(i >= 90 ? { source: inWorkout ? "workout" : "awake" } : {}) });
      }
    }

    if (hasWhoop && i < whoopLastDay) {
      const pending = i === whoopLastDay - 1;
      whoop.sleep!.push({
        id: `whoop-sleep-${p.id}-${i}`, start: bed.utcIso, end: wake.utcIso, timezone_offset: offsetLabel(bed.offsetMinutes), nap: false, score_state: pending ? "PENDING_SCORE" : "SCORED",
        ...(pending ? {} : {
          score: {
            stage_summary: { total_in_bed_time_milli: Math.round(inBedMin * 60000), total_awake_time_milli: Math.round(awakeMin * 60000), total_no_data_time_milli: 0,
                             total_light_sleep_time_milli: lightS * 1000, total_slow_wave_sleep_time_milli: deepS * 1000, total_rem_sleep_time_milli: remS * 1000,
                             sleep_cycle_count: 4, disturbance_count: Math.round(6 + r() * 8) },
            sleep_needed: { baseline_milli: 27000000, need_from_sleep_debt_milli: Math.max(0, Math.round((w.sleepHours - sleepHours) * 3600000)), need_from_recent_strain_milli: 600000, need_from_recent_nap_milli: 0 },
            respiratory_rate: round(14.8 + normal(r) * 0.6, 1), sleep_performance_percentage: Math.min(100, Math.round((sleepHours / 8) * 100)),
            sleep_consistency_percentage: Math.round(70 + r() * 20), sleep_efficiency_percentage: round((asleepS / (inBedMin * 60)) * 100, 1)
          }
        })
      });
      const cycleId = `whoop-cycle-${p.id}-${i}`;
      if (prevWake && prevCycleId) {
        // Close yesterday's cycle at this wake-up.
        const prev = whoop.cycle!.at(-1);
        if (prev) prev.end = wake.utcIso;
      }
      whoop.cycle!.push({
        id: cycleId, start: wake.utcIso, end: null, timezone_offset: offsetLabel(wake.offsetMinutes), score_state: "SCORED",
        score: { strain: round(6 + workouts.reduce((s, wk) => s + wk.strain * 0.6, 0) + r() * 3, 1), kilojoule: 8000 + steps * 0.2, average_heart_rate: Math.round(restingHr + 14), max_heart_rate: Math.round(restingHr + (workouts.length ? 100 : 60)) }
      });
      whoop.recovery!.push({
        cycle_id: cycleId, sleep_id: `whoop-sleep-${p.id}-${i}`, created_at: new Date(wake.utc.getTime() + 15 * 60000).toISOString(), score_state: pending ? "PENDING_SCORE" : "SCORED",
        ...(pending ? {} : { score: {
          user_calibrating: i < 14, recovery_score: Math.max(5, Math.min(99, Math.round(65 + (hrv - w.hrvBase) * 1.2 - (restingHr - w.restingHr) * 3 + normal(r) * 6))),
          resting_heart_rate: Math.round(restingHr), hrv_rmssd_milli: round(hrv * 1.25, 1), spo2_percentage: round(96.5 + normal(r) * 0.6, 1), skin_temp_celsius: round(33.6 + tempDev, 2)
        } })
      });
      prevCycleId = cycleId;
    }
    prevWake = wake;

    if (hasApple && i % 1 === 0) {
      for (const hour of [9, 13, 19]) {
        appleReadings.push({ metricType: "heart_rate", ts: at(day, hour, offset).utcIso, value: Math.round(restingHr + 15 + normal(r) * 6), unit: "count/min" });
      }
      appleReadings.push({ metricType: "respiratory_rate", ts: at(day, 3, offset).utcIso, value: round(14.5 + normal(r) * 0.8, 1), unit: "count/min" });
      appleReadings.push({ metricType: "oxygen_saturation", ts: at(day, 3.5, offset).utcIso, value: round(97 + normal(r) * 0.7, 1), unit: "%" });
      if (i % 7 === 0) appleReadings.push({ metricType: "weight", ts: at(day, 7.5, offset).utcIso, value: round(70 + normal(r) * 0.4 + (p.sex === "male" ? 12 : 0), 1), unit: "kg" });
    }
    prevSleepHours = sleepHours;
  }

  if (hasOura) {
    oura.personal_info!.push({ id: `oura-pi-${p.id}`, age: 2026 - Number(p.birthDate.slice(0, 4)), weight: p.sex === "male" ? 82 : 66, height: p.sex === "male" ? 1.8 : 1.66, biological_sex: p.sex, email: p.identifiers.email });
  }
  if (hasWhoop) {
    whoop.profile!.push({ user_id: Number(p.identifiers.mrn.replace(/\D/g, "")), email: p.identifiers.email, first_name: p.identifiers.given, last_name: p.identifiers.family });
    whoop.body_measurement!.push({ height_meter: p.sex === "male" ? 1.8 : 1.66, weight_kilogram: p.sex === "male" ? 82.4 : 66.2, max_heart_rate: 190 - (2026 - Number(p.birthDate.slice(0, 4))) });
  }
  return { oura, whoop, appleReadings, truth };
}
