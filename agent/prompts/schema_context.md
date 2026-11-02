# Agent views (schema `agent`, read-only)

Every view already applies the data rules: current versions only, Epic sandbox test patients hidden,
entered-in-error/cancelled/refuted records removed, only confirmed lab PDF rows, no personal identifiers.
Query only these views, always as `agent.<view>`. Dates are local calendar dates (`YYYY-MM-DD`).

## Hospital records
- `agent.v_lab_results(result_key, origin, source, loinc_code, test_name, analyte_key, value_num, value_text, comparator, unit, ref_low, ref_high, ref_text, flag, critical, effective_at, effective_date, effective_precision, report_key, document_id, code_confidence, possible_duplicate_of)`:
  one lab result. origin `hospital` or `pdf`. flag `H`/`L`/`A`/`N`/NULL is the lab's own. critical = lab marked it critical.
  PDF rows: effective_precision `document_date`, code_confidence `suggested` or `none`. possible_duplicate_of links a PDF row to the same hospital result.
- `agent.v_vitals(result_key, source, vital, loinc_code, name, value_num, value_text, unit, ref_low, ref_high, flag, critical, effective_at, effective_date, effective_precision, from_component)`:
  vital in `heart_rate`, `systolic_bp`, `diastolic_bp`, `body_temperature`, `body_weight`, `body_height`, `respiratory_rate`, `oxygen_saturation`, `bmi`, `other`.
- `agent.v_conditions(condition_key, source, name, clinical_status, verification_status, category_codes, onset_text, onset_datetime, onset_precision, abatement_text, abatement_datetime, recorded_date, icd10_codes, snomed_codes)`.
- `agent.v_prescriptions(prescription_key, source, medication, status, intent, authored_on, authored_date, dosage_text, reason_text, rxnorm_codes, meaning)`: orders, "prescribed, not confirmed as taken".
- `agent.v_medication_statements(statement_key, source, medication, status, not_taken, effective_start, effective_end, dosage_text, asserted_at)`: what the person reported taking.
- `agent.v_allergies(allergy_key, source, substance, clinical_status, verification_status, type, categories, criticality, reactions, reaction_severities, onset_text, recorded_date)`.
- `agent.v_immunizations(immunization_key, source, vaccine, status, occurred_at, occurred_date, occurred_precision)`.
- `agent.v_procedures(procedure_key, source, name, status, category, performed_at, performed_date, performed_precision, performed_text, reasons)`.
- `agent.v_encounters(encounter_key, source, status, class, types, period_start, period_end, start_date, facility, location_names, reasons)`.
- `agent.v_reports(report_key, source, name, status, category_codes, effective_at, effective_date, issued, conclusion_text, result_observation_ids, result_keys)`: result_keys has NULL for links to results not in the database.
- `agent.v_documents(document_key, source, status, type, category_codes, date, doc_date, attachment_ids, content_types, has_text)`; text is searched with tools, not SQL.
- `agent.v_family_history(family_history_key, source, relationship, condition, onset_age, onset_text, status)`.
- `agent.v_profile(age_years, recorded_sex, hospitals)`.

## Wearables (providers are never merged)
- `agent.v_sleep_nights(provider, day, session_key, start_utc, end_utc, start_local, end_local, utc_offset_minutes, score_state, total_sleep_s, deep_s, light_s, rem_s, awake_s, time_in_bed_s, latency_s, oura_efficiency_pct, whoop_efficiency_pct, average_heart_rate, lowest_heart_rate, oura_average_hrv_ms, respiratory_rate, whoop_performance_pct, whoop_consistency_pct, oura_sleep_score, nap_count, nap_sleep_s, main_sessions, record_ref)`:
  one row per provider and day; `day` is the day the person woke up. Durations in seconds.
- `agent.v_sleep_sessions(provider, session_key, day, start_utc, end_utc, start_local, end_local, utc_offset_minutes, sleep_type, is_main, score_state, total_sleep_s, deep_s, light_s, rem_s, awake_s, time_in_bed_s, latency_s, oura_efficiency_pct, whoop_efficiency_pct, average_heart_rate, lowest_heart_rate, oura_average_hrv_ms, respiratory_rate, whoop_performance_pct, whoop_consistency_pct, record_ref)`: naps included (is_main false).
- `agent.v_recovery_daily(provider, day, oura_readiness_score, oura_temperature_deviation_c, oura_temperature_trend_deviation_c, oura_hrv_balance_score, oura_resting_heart_rate_score, whoop_recovery_score, whoop_resting_heart_rate, whoop_hrv_rmssd_ms, whoop_spo2_pct, whoop_skin_temp_c, whoop_day_strain, whoop_calibrating, whoop_score_state, record_ref)`:
  one row per provider and day; oura_* columns are NULL on whoop rows and the other way round.
- `agent.v_workouts(provider, workout_key, day, start_utc, end_utc, start_local, duration_s, activity, calories_kcal, distance_m, oura_intensity_label, whoop_strain, whoop_average_heart_rate, whoop_max_heart_rate, whoop_score_state, record_ref)`.
- `agent.v_wearable_daily(source_provider, metric_type, local_day, n, mean, min, max, median, sum, first_ts, last_ts, is_sync_time, value_counts)`:
  one row per provider, metric and day. Ordinal metrics have mean/median/sum NULL and value_counts per label code.
  is_sync_time = a profile snapshot stamped when AyuOS noticed a change (weight, height, Whoop max heart rate).
- `agent.v_readings(source_provider, metric_type, ts, local_ts, value, value_label, unit, context, record_ref)`:
  raw samples. Always filter `metric_type = '...'` and `ts` to at most 31 days. context NULL = unknown.
- `agent.v_metric_catalog(metric_type, source_provider, display_name, definition, unit_canonical, value_kind, ordinal_labels, comparable_group, day_anchor, cautions, first_day, last_day, days_with_data)`.
- `agent.v_data_freshness(kind, source, display_name, status, sandbox, last_data_at, last_sync_at, last_error, item_count)`.

Provider values are lowercase: `oura`, `whoop`, `apple_health`.

## Never compare across these groups
- Oura `heart_rate_variability_sdnn` (SDNN) vs Whoop `heart_rate_variability_rmssd` / `whoop_hrv_rmssd_ms` (RMSSD).
- Oura `skin_temperature_deviation` (difference from baseline) vs Whoop `skin_temperature` (absolute).
- Oura `readiness_score` vs Whoop `recovery_score`; each provider's `sleep_efficiency`.
- Oura `energy` (active kcal) vs `total_energy` (total kcal). Oura `oxygen_saturation` (nightly average) vs Apple Health spot readings.
Use `comparable_group` in `agent.v_metric_catalog`: only equal groups may be compared or merged.

## Ordinal labels (count them, never average)
- `sleep_stage`: 1 deep, 2 light, 3 REM, 4 awake. `activity_class`: 0 non-wear, 1 rest, 2 inactive, 3 low, 4 medium, 5 high.
- `sleep_movement` 1-4, `stress_day_summary` 1 restored, 2 normal, 3 stressful, `resilience_level` 1-5, `workout_intensity` 1 easy, 2 moderate, 3 hard.

## Time rules
- Daily wearable values (sleep, readiness, recovery, scores, activity) belong to the provider's day: use `day` or `local_day`, never derive a day from a timestamp.
- Samples: `local_ts` is the person's local time from their offset history; use `local_ts::date` for days.
- Hospital date-only values keep their calendar date; `*_precision` says year, month, date or instant.
- Lab PDF results share one document date.

## Provenance
Each row carries a key (`result_key`, `record_ref`, `*_key`) naming the source record; keep it when you can.
