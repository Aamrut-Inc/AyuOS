// The metric catalog: one entry per (metric_type, source_provider) that
// AyuOS writes to timeseries.readings (handbook §4.3; extract/wearables/oura.ts,
// whoop.ts, extract/apple-health/parse-vitals.ts). Seeded into
// agent.metric_catalog by load/migrations/0013_agent_metric_catalog.sql, which
// is generated from this file (bun run agent/catalog/generate-seed.ts).
//
// comparable_group is what stops wrong comparisons: two rows may only be
// compared or merged when their groups are equal. Provider scores, ordinals
// and anything computed with a provider's own formula get a group of their own.

export type ValueKind = "continuous_sample" | "daily_value" | "per_session" | "snapshot" | "ordinal" | "score";
export type DayAnchor = "records_day" | "local_ts" | "sync_time";
export type Provider = "oura" | "whoop" | "apple_health";

export interface MetricEntry {
  metric_type: string;
  source_provider: Provider;
  display_name: string;
  definition: string;
  unit_canonical: string;
  unit_aliases: string[];
  value_kind: ValueKind;
  ordinal_labels: Record<string, string> | null;
  comparable_group: string;
  day_anchor: DayAnchor;
  stored_in: "readings" | "records";
  cautions: string | null;
}

type Spec = Partial<MetricEntry> & { display_name: string; definition: string; unit_canonical: string; value_kind: ValueKind };

const SLEEP_STAGE = { "1": "deep", "2": "light", "3": "REM", "4": "awake" };
const ACTIVITY_CLASS = { "0": "non-wear", "1": "rest", "2": "inactive", "3": "low", "4": "medium", "5": "high" };
const SLEEP_MOVEMENT = { "1": "no motion", "2": "restless", "3": "tossing", "4": "active" };
const STRESS_SUMMARY = { "1": "restored", "2": "normal", "3": "stressful" };
const RESILIENCE = { "1": "limited", "2": "adequate", "3": "solid", "4": "strong", "5": "exceptional" };
const OURA_INTENSITY = { "1": "easy", "2": "moderate", "3": "hard" };

const PROVIDER_SCORE = "This is the provider's own proprietary score, not a medical measurement.";

function entries(provider: Provider, anchor: DayAnchor, specs: Record<string, Spec>): MetricEntry[] {
  return Object.entries(specs).map(([metric_type, s]) => ({
    metric_type,
    source_provider: provider,
    display_name: s.display_name,
    definition: s.definition,
    unit_canonical: s.unit_canonical,
    unit_aliases: s.unit_aliases ?? [],
    value_kind: s.value_kind,
    ordinal_labels: s.ordinal_labels ?? null,
    // Scores and ordinals never compare across providers.
    comparable_group:
      s.comparable_group ??
      (s.value_kind === "score" || s.value_kind === "ordinal" ? `${provider}:${metric_type}` : metric_type),
    day_anchor: s.day_anchor ?? anchor,
    stored_in: s.stored_in ?? "readings",
    cautions: s.cautions ?? (s.value_kind === "score" ? PROVIDER_SCORE : null)
  }));
}

function contributors(prefix: string, names: string[], what: string): Record<string, Spec> {
  return Object.fromEntries(
    names.map((name) => [
      `${prefix}_contributor_${name}`,
      {
        display_name: `Oura ${what} contributor: ${name.replaceAll("_", " ")}`,
        definition: `Oura's 0-100 sub-score for "${name.replaceAll("_", " ")}" within its ${what} score.`,
        unit_canonical: "score",
        value_kind: "score" as const
      }
    ])
  );
}

const SLEEP_SESSION_NOTE = "Recorded per sleep period; naps and main sleep are separate (context holds the sleep type).";

const OURA: Record<string, Spec> = {
  heart_rate: {
    display_name: "Heart rate (Oura)", definition: "Heart beats per minute measured by the ring.",
    unit_canonical: "bpm", unit_aliases: ["count/min"], value_kind: "continuous_sample", day_anchor: "local_ts",
    cautions: "context is NULL on readings written before 2026-10-22; treat NULL as unknown, not awake."
  },
  heart_rate_variability_sdnn: {
    display_name: "HRV, SDNN (Oura)", definition: "Variation between heartbeats during sleep, computed by Oura as SDNN in milliseconds.",
    unit_canonical: "ms", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "hrv_sdnn",
    cautions: "SDNN is a different formula from Whoop's RMSSD; never compare or merge them."
  },
  steps: { display_name: "Steps (Oura)", definition: "Steps counted by the ring over the Oura activity day.", unit_canonical: "count", value_kind: "daily_value" },
  energy: {
    display_name: "Active energy (Oura)", definition: "Active calories burned over the Oura activity day (excludes resting energy).",
    unit_canonical: "kcal", value_kind: "daily_value", comparable_group: "active_energy",
    cautions: "Active kcal only; total_energy is total kcal."
  },
  total_energy: { display_name: "Total energy (Oura)", definition: "Total calories burned over the Oura activity day.", unit_canonical: "kcal", value_kind: "daily_value" },
  target_energy: { display_name: "Active energy target (Oura)", definition: "Oura's daily active-calorie target.", unit_canonical: "kcal", value_kind: "daily_value", comparable_group: "oura:target_energy" },
  distance_walking_running: { display_name: "Walking/running distance (Oura)", definition: "Equivalent walking distance over the Oura activity day.", unit_canonical: "meters", value_kind: "daily_value" },
  target_distance: { display_name: "Distance target (Oura)", definition: "Oura's daily distance target.", unit_canonical: "meters", value_kind: "daily_value", comparable_group: "oura:target_distance" },
  distance_to_target: { display_name: "Distance to target (Oura)", definition: "Distance still needed to reach Oura's daily target.", unit_canonical: "meters", value_kind: "daily_value", comparable_group: "oura:distance_to_target" },
  activity_score: { display_name: "Oura activity score", definition: "Oura's 0-100 daily activity score.", unit_canonical: "score", value_kind: "score" },
  ...contributors("activity", ["meet_daily_targets", "move_every_hour", "recovery_time", "stay_active", "training_frequency", "training_volume"], "activity"),
  inactivity_alerts: { display_name: "Inactivity alerts (Oura)", definition: "Number of times Oura prompted the person to move.", unit_canonical: "count", value_kind: "daily_value", comparable_group: "oura:inactivity_alerts" },
  average_met_minutes: { display_name: "Average MET (Oura)", definition: "Average metabolic equivalent over the activity day.", unit_canonical: "met_min", value_kind: "daily_value" },
  high_activity_met_minutes: { display_name: "High-activity MET-minutes (Oura)", definition: "MET-minutes spent in high activity.", unit_canonical: "met_min", value_kind: "daily_value" },
  medium_activity_met_minutes: { display_name: "Medium-activity MET-minutes (Oura)", definition: "MET-minutes spent in medium activity.", unit_canonical: "met_min", value_kind: "daily_value" },
  low_activity_met_minutes: { display_name: "Low-activity MET-minutes (Oura)", definition: "MET-minutes spent in low activity.", unit_canonical: "met_min", value_kind: "daily_value" },
  sedentary_met_minutes: { display_name: "Sedentary MET-minutes (Oura)", definition: "MET-minutes spent sedentary.", unit_canonical: "met_min", value_kind: "daily_value" },
  high_activity_time: { display_name: "High-activity time (Oura)", definition: "Seconds spent in high activity.", unit_canonical: "s", value_kind: "daily_value" },
  medium_activity_time: { display_name: "Medium-activity time (Oura)", definition: "Seconds spent in medium activity.", unit_canonical: "s", value_kind: "daily_value" },
  low_activity_time: { display_name: "Low-activity time (Oura)", definition: "Seconds spent in low activity.", unit_canonical: "s", value_kind: "daily_value" },
  sedentary_time: { display_name: "Sedentary time (Oura)", definition: "Seconds spent sedentary.", unit_canonical: "s", value_kind: "daily_value" },
  resting_time: { display_name: "Resting time (Oura)", definition: "Seconds spent resting.", unit_canonical: "s", value_kind: "daily_value" },
  non_wear_time: {
    display_name: "Ring not worn (Oura)", definition: "Seconds in the activity day when the ring was not worn.",
    unit_canonical: "s", value_kind: "daily_value", comparable_group: "oura:non_wear_time",
    cautions: "High values mean the day's other values are incomplete."
  },
  met: { display_name: "MET, 1-minute samples (Oura)", definition: "Metabolic equivalent sampled every minute.", unit_canonical: "met", value_kind: "continuous_sample", day_anchor: "local_ts" },
  activity_class: { display_name: "Activity class (Oura)", definition: "Oura's 5-minute activity label.", unit_canonical: "class", value_kind: "ordinal", ordinal_labels: ACTIVITY_CLASS, day_anchor: "local_ts", cautions: "Labels, not quantities: count them, never average." },
  sleep_score: { display_name: "Oura sleep score", definition: "Oura's 0-100 daily sleep score.", unit_canonical: "score", value_kind: "score" },
  ...contributors("sleep", ["deep_sleep", "efficiency", "latency", "rem_sleep", "restfulness", "timing", "total_sleep"], "sleep"),
  readiness_score: { display_name: "Oura readiness score", definition: "Oura's 0-100 daily readiness score.", unit_canonical: "score", value_kind: "score", cautions: `${PROVIDER_SCORE} Not comparable with Whoop's recovery score.` },
  ...contributors("readiness", ["activity_balance", "body_temperature", "hrv_balance", "previous_day_activity", "previous_night", "recovery_index", "resting_heart_rate", "sleep_balance", "sleep_regularity"], "readiness"),
  skin_temperature_deviation: {
    display_name: "Skin temperature deviation (Oura)", definition: "Difference of skin temperature from the person's own baseline, in °C.",
    unit_canonical: "celsius", value_kind: "daily_value", comparable_group: "skin_temp_deviation",
    cautions: "A difference from baseline, not body temperature; not comparable with Whoop's absolute skin temperature."
  },
  skin_temperature_trend_deviation: {
    display_name: "Skin temperature trend deviation (Oura)", definition: "Oura's smoothed trend of skin temperature difference from baseline, in °C.",
    unit_canonical: "celsius", value_kind: "daily_value", comparable_group: "oura:skin_temp_trend_deviation"
  },
  oxygen_saturation: {
    display_name: "Blood oxygen, nightly average (Oura)", definition: "Average blood oxygen saturation during the night.",
    unit_canonical: "percent", unit_aliases: ["%"], value_kind: "daily_value", comparable_group: "spo2_nightly_average",
    cautions: "A nightly average; Apple Health values are spot readings."
  },
  breathing_disturbance_index: { display_name: "Breathing disturbance index (Oura)", definition: "Oura's index of breathing disturbances during sleep.", unit_canonical: "score", value_kind: "score" },
  stress_high_time: { display_name: "High-stress time (Oura)", definition: "Seconds of the day Oura classed as high stress.", unit_canonical: "s", value_kind: "daily_value", comparable_group: "oura:stress_high_time" },
  recovery_high_time: { display_name: "High-recovery time (Oura)", definition: "Seconds of the day Oura classed as high recovery.", unit_canonical: "s", value_kind: "daily_value", comparable_group: "oura:recovery_high_time" },
  stress_day_summary: { display_name: "Day stress summary (Oura)", definition: "Oura's label for the day's stress.", unit_canonical: "level", value_kind: "ordinal", ordinal_labels: STRESS_SUMMARY },
  resilience_level: { display_name: "Resilience level (Oura)", definition: "Oura's resilience label.", unit_canonical: "level", value_kind: "ordinal", ordinal_labels: RESILIENCE },
  ...contributors("resilience", ["sleep_recovery", "daytime_recovery", "stress"], "resilience"),
  cardiovascular_age: { display_name: "Cardiovascular age (Oura)", definition: "Oura's estimate of how old the heart and vessels look, from pulse wave velocity.", unit_canonical: "years", value_kind: "score" },
  pulse_wave_velocity: { display_name: "Pulse wave velocity (Oura)", definition: "Speed of the pressure wave through the arteries.", unit_canonical: "m/s", value_kind: "daily_value" },
  vo2_max: { display_name: "VO2 max (Oura)", definition: "Oura's estimate of maximum oxygen uptake.", unit_canonical: "ml_kg_min", value_kind: "daily_value", comparable_group: "oura:vo2_max" },
  sleep_total_duration: { display_name: "Total sleep (Oura)", definition: "Seconds asleep (light, deep and REM) in one sleep period.", unit_canonical: "s", value_kind: "per_session", cautions: SLEEP_SESSION_NOTE },
  sleep_deep_duration: { display_name: "Deep sleep (Oura)", definition: "Seconds of deep sleep in one sleep period.", unit_canonical: "s", value_kind: "per_session", cautions: SLEEP_SESSION_NOTE },
  sleep_light_duration: { display_name: "Light sleep (Oura)", definition: "Seconds of light sleep in one sleep period.", unit_canonical: "s", value_kind: "per_session", cautions: SLEEP_SESSION_NOTE },
  sleep_rem_duration: { display_name: "REM sleep (Oura)", definition: "Seconds of REM sleep in one sleep period.", unit_canonical: "s", value_kind: "per_session", cautions: SLEEP_SESSION_NOTE },
  sleep_awake_time: { display_name: "Awake time in bed (Oura)", definition: "Seconds awake during one sleep period.", unit_canonical: "s", value_kind: "per_session", cautions: SLEEP_SESSION_NOTE },
  sleep_time_in_bed: { display_name: "Time in bed (Oura)", definition: "Seconds in bed for one sleep period.", unit_canonical: "s", value_kind: "per_session", cautions: SLEEP_SESSION_NOTE },
  sleep_latency: { display_name: "Sleep latency (Oura)", definition: "Seconds taken to fall asleep.", unit_canonical: "s", value_kind: "per_session", comparable_group: "oura:sleep_latency" },
  sleep_efficiency: { display_name: "Sleep efficiency (Oura)", definition: "Percentage of time in bed spent asleep, by Oura's formula.", unit_canonical: "percent", value_kind: "per_session", comparable_group: "oura:sleep_efficiency", cautions: "Oura's own formula; not comparable with Whoop's." },
  sleep_respiratory_rate: { display_name: "Breathing rate during sleep (Oura)", definition: "Average breaths per minute during one sleep period.", unit_canonical: "breaths/min", value_kind: "per_session" },
  sleep_average_heart_rate: { display_name: "Average heart rate in sleep (Oura)", definition: "Average heart rate during one sleep period.", unit_canonical: "bpm", value_kind: "per_session" },
  sleep_lowest_heart_rate: { display_name: "Lowest heart rate in sleep (Oura's resting heart rate)", definition: "Lowest heart rate during one sleep period; the Oura app shows it as resting heart rate.", unit_canonical: "bpm", value_kind: "per_session", comparable_group: "oura:sleep_lowest_heart_rate" },
  sleep_average_hrv: { display_name: "Average HRV in sleep (Oura)", definition: "Average heart rate variability during one sleep period, in ms (Oura's measure).", unit_canonical: "ms", value_kind: "per_session", comparable_group: "oura:sleep_average_hrv", cautions: "Oura's HRV measure; never compare with Whoop's RMSSD." },
  sleep_restless_periods: { display_name: "Restless periods (Oura)", definition: "Number of restless periods in one sleep period.", unit_canonical: "count", value_kind: "per_session", comparable_group: "oura:sleep_restless_periods" },
  sleep_score_delta: { display_name: "Sleep score change (Oura)", definition: "How much this sleep period changed Oura's sleep score.", unit_canonical: "score", value_kind: "score" },
  readiness_score_delta: { display_name: "Readiness score change (Oura)", definition: "How much this sleep period changed Oura's readiness score.", unit_canonical: "score", value_kind: "score" },
  sleep_stage: { display_name: "Sleep stage, 5-minute (Oura)", definition: "Oura's sleep stage for each 5 minutes of a sleep period.", unit_canonical: "stage", value_kind: "ordinal", ordinal_labels: SLEEP_STAGE, day_anchor: "local_ts", cautions: "Labels, not quantities: count them, never average." },
  sleep_movement: { display_name: "Movement in sleep, 30-second (Oura)", definition: "Oura's movement level for each 30 seconds of sleep.", unit_canonical: "level", value_kind: "ordinal", ordinal_labels: SLEEP_MOVEMENT, day_anchor: "local_ts" },
  optimal_bedtime_start_offset: { display_name: "Recommended bedtime window start (Oura)", definition: "Start of Oura's recommended bedtime window, as seconds from local midnight.", unit_canonical: "s", value_kind: "daily_value", comparable_group: "oura:optimal_bedtime_start_offset" },
  optimal_bedtime_end_offset: { display_name: "Recommended bedtime window end (Oura)", definition: "End of Oura's recommended bedtime window, as seconds from local midnight.", unit_canonical: "s", value_kind: "daily_value", comparable_group: "oura:optimal_bedtime_end_offset" },
  workout_duration: { display_name: "Workout duration (Oura)", definition: "Seconds of one workout.", unit_canonical: "s", value_kind: "per_session" },
  workout_calories: { display_name: "Workout calories (Oura)", definition: "Calories burned in one workout.", unit_canonical: "kcal", value_kind: "per_session" },
  workout_distance: { display_name: "Workout distance (Oura)", definition: "Distance covered in one workout.", unit_canonical: "meters", value_kind: "per_session" },
  workout_intensity: { display_name: "Workout intensity (Oura)", definition: "Oura's intensity label for one workout.", unit_canonical: "level", value_kind: "ordinal", ordinal_labels: OURA_INTENSITY },
  session_duration: { display_name: "Session duration (Oura)", definition: "Seconds of a meditation or breathing session.", unit_canonical: "s", value_kind: "per_session" },
  session_heart_rate: { display_name: "Session heart rate (Oura)", definition: "Heart rate samples during a session.", unit_canonical: "bpm", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "oura:session_heart_rate" },
  session_hrv: { display_name: "Session HRV (Oura)", definition: "Heart rate variability samples during a session.", unit_canonical: "ms", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "oura:session_hrv" },
  session_motion_count: { display_name: "Session motion (Oura)", definition: "Motion counts during a session.", unit_canonical: "count", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "oura:session_motion_count" },
  ring_battery_level: { display_name: "Ring battery (Oura)", definition: "Ring battery charge.", unit_canonical: "percent", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "oura:ring_battery_level" },
  weight: { display_name: "Weight (Oura profile)", definition: "Weight entered in the Oura profile.", unit_canonical: "kg", value_kind: "snapshot", day_anchor: "sync_time", comparable_group: "body_weight", cautions: "Stamped when AyuOS noticed a change, not when the person was weighed." },
  height: { display_name: "Height (Oura profile)", definition: "Height entered in the Oura profile.", unit_canonical: "cm", value_kind: "snapshot", day_anchor: "sync_time", comparable_group: "body_height", cautions: "Stamped when AyuOS noticed a change." }
};

const WHOOP_SLEEP = "Recorded per sleep; context is 'nap' or 'sleep'.";

const WHOOP: Record<string, Spec> = {
  strain: { display_name: "Whoop day strain", definition: "Whoop's cardiovascular load for its physiological day, on a 0-21 scale.", unit_canonical: "strain", value_kind: "score" },
  total_energy: { display_name: "Total energy (Whoop)", definition: "Total calories burned over the Whoop cycle.", unit_canonical: "kcal", value_kind: "daily_value" },
  average_heart_rate: { display_name: "Average heart rate over the day (Whoop)", definition: "Average heart rate across the Whoop cycle.", unit_canonical: "bpm", value_kind: "daily_value", comparable_group: "whoop:cycle_average_heart_rate" },
  max_heart_rate: { display_name: "Maximum heart rate (Whoop)", definition: "Highest heart rate in the Whoop cycle; also the profile's max heart rate snapshot.", unit_canonical: "bpm", value_kind: "daily_value", comparable_group: "whoop:max_heart_rate", cautions: "Profile snapshots of max heart rate are stamped at sync time." },
  steps: { display_name: "Steps (Whoop)", definition: "Steps counted by Whoop over its cycle.", unit_canonical: "count", value_kind: "daily_value" },
  recovery_score: { display_name: "Whoop recovery score", definition: "Whoop's 0-100% daily recovery score.", unit_canonical: "percent", value_kind: "score", cautions: `${PROVIDER_SCORE} Not comparable with Oura's readiness score. context 'calibrating' means Whoop is still calibrating.` },
  resting_heart_rate: { display_name: "Resting heart rate (Whoop)", definition: "Resting heart rate Whoop measured during sleep.", unit_canonical: "bpm", value_kind: "daily_value", comparable_group: "resting_heart_rate" },
  heart_rate_variability_rmssd: { display_name: "HRV, RMSSD (Whoop)", definition: "Heart rate variability Whoop measured during sleep, computed as RMSSD in milliseconds.", unit_canonical: "ms", value_kind: "daily_value", comparable_group: "hrv_rmssd", cautions: "RMSSD is a different formula from Oura's SDNN; never compare or merge them." },
  oxygen_saturation: { display_name: "Blood oxygen (Whoop recovery)", definition: "Blood oxygen Whoop measured during sleep.", unit_canonical: "percent", unit_aliases: ["%"], value_kind: "daily_value", comparable_group: "whoop:spo2" },
  skin_temperature: { display_name: "Skin temperature (Whoop)", definition: "Absolute skin temperature Whoop measured during sleep, in °C.", unit_canonical: "celsius", value_kind: "daily_value", comparable_group: "skin_temp_absolute", cautions: "Absolute temperature; not comparable with Oura's deviation from baseline." },
  sleep_total_duration: { display_name: "Total sleep (Whoop)", definition: "Seconds asleep (light, slow-wave and REM) in one Whoop sleep.", unit_canonical: "s", value_kind: "per_session", cautions: WHOOP_SLEEP },
  sleep_deep_duration: { display_name: "Deep (slow-wave) sleep (Whoop)", definition: "Seconds of slow-wave sleep in one Whoop sleep.", unit_canonical: "s", value_kind: "per_session", cautions: WHOOP_SLEEP },
  sleep_light_duration: { display_name: "Light sleep (Whoop)", definition: "Seconds of light sleep in one Whoop sleep.", unit_canonical: "s", value_kind: "per_session", cautions: WHOOP_SLEEP },
  sleep_rem_duration: { display_name: "REM sleep (Whoop)", definition: "Seconds of REM sleep in one Whoop sleep.", unit_canonical: "s", value_kind: "per_session", cautions: WHOOP_SLEEP },
  sleep_awake_time: { display_name: "Awake time in bed (Whoop)", definition: "Seconds awake during one Whoop sleep.", unit_canonical: "s", value_kind: "per_session", cautions: WHOOP_SLEEP },
  sleep_time_in_bed: { display_name: "Time in bed (Whoop)", definition: "Seconds in bed for one Whoop sleep.", unit_canonical: "s", value_kind: "per_session", cautions: WHOOP_SLEEP },
  sleep_no_data_time: { display_name: "Sleep without data (Whoop)", definition: "Seconds of a Whoop sleep with no data.", unit_canonical: "s", value_kind: "per_session", comparable_group: "whoop:sleep_no_data_time" },
  sleep_need_baseline: { display_name: "Baseline sleep need (Whoop)", definition: "Whoop's baseline estimate of sleep needed.", unit_canonical: "s", value_kind: "per_session", comparable_group: "whoop:sleep_need_baseline" },
  sleep_need_from_sleep_debt: { display_name: "Sleep need from sleep debt (Whoop)", definition: "Extra sleep Whoop says is needed for sleep debt.", unit_canonical: "s", value_kind: "per_session", comparable_group: "whoop:sleep_need_from_sleep_debt" },
  sleep_need_from_recent_strain: { display_name: "Sleep need from strain (Whoop)", definition: "Extra sleep Whoop says is needed for recent strain.", unit_canonical: "s", value_kind: "per_session", comparable_group: "whoop:sleep_need_from_recent_strain" },
  sleep_need_from_recent_nap: { display_name: "Sleep need change from naps (Whoop)", definition: "Change in sleep need Whoop credits to recent naps.", unit_canonical: "s", value_kind: "per_session", comparable_group: "whoop:sleep_need_from_recent_nap" },
  sleep_cycle_count: { display_name: "Sleep cycles (Whoop)", definition: "Number of sleep cycles in one Whoop sleep.", unit_canonical: "count", value_kind: "per_session", comparable_group: "whoop:sleep_cycle_count" },
  sleep_disturbance_count: { display_name: "Sleep disturbances (Whoop)", definition: "Number of disturbances in one Whoop sleep.", unit_canonical: "count", value_kind: "per_session", comparable_group: "whoop:sleep_disturbance_count" },
  sleep_respiratory_rate: { display_name: "Breathing rate during sleep (Whoop)", definition: "Average breaths per minute during one Whoop sleep.", unit_canonical: "breaths/min", value_kind: "per_session" },
  sleep_performance: { display_name: "Whoop sleep performance", definition: "Whoop's percentage of sleep need achieved.", unit_canonical: "percent", value_kind: "score" },
  sleep_consistency: { display_name: "Whoop sleep consistency", definition: "Whoop's percentage score for consistent sleep timing.", unit_canonical: "percent", value_kind: "score" },
  sleep_efficiency: { display_name: "Sleep efficiency (Whoop)", definition: "Percentage of time in bed spent asleep, by Whoop's formula.", unit_canonical: "percent", value_kind: "per_session", comparable_group: "whoop:sleep_efficiency", cautions: "Whoop's own formula; not comparable with Oura's." },
  workout_duration: { display_name: "Workout duration (Whoop)", definition: "Seconds of one workout.", unit_canonical: "s", value_kind: "per_session" },
  workout_strain: { display_name: "Whoop workout strain", definition: "Whoop's strain for one workout, 0-21 scale.", unit_canonical: "strain", value_kind: "score" },
  workout_average_heart_rate: { display_name: "Workout average heart rate (Whoop)", definition: "Average heart rate during one workout.", unit_canonical: "bpm", value_kind: "per_session" },
  workout_max_heart_rate: { display_name: "Workout maximum heart rate (Whoop)", definition: "Highest heart rate during one workout.", unit_canonical: "bpm", value_kind: "per_session" },
  workout_calories: { display_name: "Workout calories (Whoop)", definition: "Calories burned in one workout.", unit_canonical: "kcal", value_kind: "per_session" },
  workout_distance: { display_name: "Workout distance (Whoop)", definition: "Distance covered in one workout.", unit_canonical: "meters", value_kind: "per_session" },
  workout_altitude_gain: { display_name: "Workout altitude gain (Whoop)", definition: "Metres climbed in one workout.", unit_canonical: "meters", value_kind: "per_session" },
  workout_altitude_change: { display_name: "Workout altitude change (Whoop)", definition: "Net altitude change in one workout.", unit_canonical: "meters", value_kind: "per_session" },
  workout_percent_recorded: { display_name: "Workout data recorded (Whoop)", definition: "Percentage of the workout with heart-rate data.", unit_canonical: "percent", value_kind: "per_session", comparable_group: "whoop:workout_percent_recorded" },
  ...Object.fromEntries(
    [0, 1, 2, 3, 4, 5].map((z) => [
      `workout_zone_${z}_duration`,
      { display_name: `Time in heart-rate zone ${z} (Whoop)`, definition: `Seconds of one workout in Whoop heart-rate zone ${z}.`, unit_canonical: "s", value_kind: "per_session" as const, comparable_group: `whoop:workout_zone_${z}_duration` }
    ])
  ),
  weight: { display_name: "Weight (Whoop profile)", definition: "Weight in the Whoop body measurement.", unit_canonical: "kg", value_kind: "snapshot", day_anchor: "sync_time", comparable_group: "body_weight", cautions: "Stamped when AyuOS noticed a change, not when the person was weighed." },
  height: { display_name: "Height (Whoop profile)", definition: "Height in the Whoop body measurement.", unit_canonical: "cm", value_kind: "snapshot", day_anchor: "sync_time", comparable_group: "body_height", cautions: "Stamped when AyuOS noticed a change." }
};

const APPLE: Record<string, Spec> = {
  heart_rate: { display_name: "Heart rate (Apple Health)", definition: "Heart rate measurements from the iPhone Health export.", unit_canonical: "count/min", unit_aliases: ["bpm"], value_kind: "continuous_sample", day_anchor: "local_ts", cautions: "Apple Health may contain values copied from the ring; don't add them to Oura's." },
  respiratory_rate: { display_name: "Breathing rate (Apple Health)", definition: "Breaths per minute from the iPhone Health export.", unit_canonical: "count/min", value_kind: "continuous_sample", day_anchor: "local_ts" },
  oxygen_saturation: { display_name: "Blood oxygen, spot readings (Apple Health)", definition: "Blood oxygen spot readings from the iPhone Health export.", unit_canonical: "%", unit_aliases: ["percent"], value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "spo2_spot" },
  weight: { display_name: "Weight (Apple Health)", definition: "Weight measurements from the iPhone Health export, at the measurement time.", unit_canonical: "kg", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "body_weight" },
  height: { display_name: "Height (Apple Health)", definition: "Height measurements from the iPhone Health export.", unit_canonical: "cm", value_kind: "continuous_sample", day_anchor: "local_ts", comparable_group: "body_height" }
};

// Oura daily values sit at UTC midnight of their day label or at the local
// start of the activity day; Whoop's at its cycle, sleep or workout start.
// Both resolve to the provider's own day (agent._wearable_day_anchor).
export const METRIC_CATALOG: MetricEntry[] = [
  ...entries("oura", "records_day", OURA),
  ...entries("whoop", "records_day", WHOOP),
  ...entries("apple_health", "local_ts", APPLE)
];
