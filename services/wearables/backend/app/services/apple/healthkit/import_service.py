import json
from decimal import Decimal
from logging import Logger, getLogger
from typing import Iterable
from uuid import UUID, uuid4

from app.database import DbSession
from app.schemas import (
    HKRecordJSON,
    HKWorkoutJSON,
    HeartRateSampleCreate,
    HealthRecordCreate,
    RootJSON,
    StepSampleCreate,
    UploadDataResponse,
)
from app.services.workout_service import workout_service
from app.services.workout_statistic_service import time_series_service


class ImportService:
    def __init__(self, log: Logger, **kwargs):
        self.log = log
        self.workout_service = workout_service
        self.time_series_service = time_series_service

    def _dec(self, value: float | int | Decimal | None) -> Decimal | None:
        return None if value is None else Decimal(str(value))

    def _build_workout_bundles(
        self,
        raw: dict,
        user_id: str,
    ) -> Iterable[HealthRecordCreate]:
        """
        Given the parsed JSON dict from HealthAutoExport, yield ImportBundle(s)
        ready to insert into your ORM session.
        """
        root = RootJSON(**raw)
        workouts_raw = root.data.get("workouts", [])
        for w in workouts_raw:
            wjson = HKWorkoutJSON(**w)

            provider_id = wjson.uuid if wjson.uuid else None

            duration_seconds = (wjson.endDate - wjson.startDate).total_seconds()

            metrics = self._extract_metrics_from_workout_stats(wjson.workoutStatistics)

            workout_create = HealthRecordCreate(
                id=uuid4(),
                provider_id=provider_id,
                user_id=UUID(user_id),
                type=wjson.type or "Unknown",
                duration_seconds=Decimal(duration_seconds),
                source_name=wjson.sourceName or "Apple Health",
                start_datetime=wjson.startDate,
                end_datetime=wjson.endDate,
                **metrics,
            )

            yield workout_create

    def _build_statistic_bundles(
        self,
        raw: dict,
        _user_id: str,
    ) -> Iterable[tuple[list[HeartRateSampleCreate], list[StepSampleCreate]]]:
        root = RootJSON(**raw)
        records_raw = root.data.get("records", [])
        heart_rate_samples: list[HeartRateSampleCreate] = []
        step_samples: list[StepSampleCreate] = []

        for r in records_raw:
            rjson = HKRecordJSON(**r)
            value = Decimal(str(rjson.value))

            if rjson.type and "HeartRate" in rjson.type:
                heart_rate_samples.append(
                    HeartRateSampleCreate(
                        id=uuid4(),
                        device_id=rjson.sourceName or None,
                        recorded_at=rjson.startDate,
                        value=value,
                    ),
                )
            elif rjson.type and "StepCount" in rjson.type:
                step_samples.append(
                    StepSampleCreate(
                        id=uuid4(),
                        device_id=rjson.sourceName or None,
                        recorded_at=rjson.startDate,
                        value=value,
                    ),
                )

        yield heart_rate_samples, step_samples

    def _extract_metrics_from_workout_stats(self, stats: list | None) -> dict[str, Decimal | None]:
        heart_rate_values: list[Decimal] = []
        step_values: list[Decimal] = []

        if stats:
            for stat in stats:
                value = self._dec(stat.value)
                if value is None or stat.type is None:
                    continue
                lowered = stat.type.lower()
                if "heart" in lowered:
                    heart_rate_values.append(value)
                elif "step" in lowered:
                    step_values.append(value)

        def _compute(values: list[Decimal]) -> tuple[Decimal | None, Decimal | None, Decimal | None]:
            if not values:
                return None, None, None
            min_v = min(values)
            max_v = max(values)
            avg_v = sum(values) / Decimal(len(values))
            return min_v, max_v, avg_v

        hr_min, hr_max, hr_avg = _compute(heart_rate_values)
        steps_min, steps_max, steps_avg = _compute(step_values)

        return {
            "heart_rate_min": hr_min,
            "heart_rate_max": hr_max,
            "heart_rate_avg": hr_avg,
            "steps_min": steps_min,
            "steps_max": steps_max,
            "steps_avg": steps_avg,
        }

    def load_data(self, db_session: DbSession, raw: dict, user_id: str) -> bool:
        for workout_row in self._build_workout_bundles(raw, user_id):
            self.workout_service.create(db_session, workout_row)

        for heart_rate_records, step_records in self._build_statistic_bundles(raw, user_id):
            if heart_rate_records:
                self.time_series_service.bulk_create_heart_rate_samples(db_session, heart_rate_records)
            if step_records:
                self.time_series_service.bulk_create_step_samples(db_session, step_records)

        return True

    async def import_data_from_request(
        self,
        db_session: DbSession,
        request_content: str,
        content_type: str,
        user_id: str,
    ) -> UploadDataResponse:
        try:
            # Parse content based on type
            if "multipart/form-data" in content_type:
                data = self._parse_multipart_content(request_content)
            else:
                data = self._parse_json_content(request_content)

            if not data:
                return UploadDataResponse(status_code=400, response="No valid data found")

            # Load data using provided database session
            self.load_data(db_session, data, user_id=user_id)

        except Exception as e:
            return UploadDataResponse(status_code=400, response=f"Import failed: {str(e)}")

        return UploadDataResponse(status_code=200, response="Import successful")

    def _parse_multipart_content(self, content: str) -> dict | None:
        """Parse multipart form data to extract JSON."""
        json_start = content.find('{\n  "data"')
        if json_start == -1:
            json_start = content.find('{"data"')
        if json_start == -1:
            return None

        brace_count = 0
        json_end = json_start
        for i, char in enumerate(content[json_start:], json_start):
            if char == "{":
                brace_count += 1
            elif char == "}":
                brace_count -= 1
                if brace_count == 0:
                    json_end = i
                    break

        if brace_count != 0:
            return None

        json_str = content[json_start : json_end + 1]
        return json.loads(json_str)

    def _parse_json_content(self, content: str) -> dict | None:
        """Parse JSON content directly."""
        try:
            return json.loads(content)
        except json.JSONDecodeError:
            return None


import_service = ImportService(log=getLogger(__name__))
