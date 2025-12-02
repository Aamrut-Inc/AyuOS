from datetime import datetime
from decimal import Decimal
from typing import Any, Iterable
from uuid import UUID, uuid4

from app.database import DbSession
from app.schemas import HealthRecordCreate, SuuntoWorkoutJSON
from app.services.providers.templates.base_workouts import BaseWorkoutsTemplate
from app.services.workout_service import workout_service


class SuuntoWorkouts(BaseWorkoutsTemplate):
    """Suunto implementation of workouts template."""

    def _get_suunto_headers(self) -> dict[str, str]:
        """Get Suunto-specific headers including subscription key."""
        headers = {}
        if self.oauth and hasattr(self.oauth, "credentials"):
            subscription_key = self.oauth.credentials.subscription_key
            if subscription_key:
                headers["Ocp-Apim-Subscription-Key"] = subscription_key
        return headers

    def get_workouts(
        self,
        db: DbSession,
        user_id: UUID,
        start_date: datetime,
        end_date: datetime,
    ) -> list[Any]:
        """Get workouts from Suunto API."""
        # Suunto uses 'since' parameter
        since = int(start_date.timestamp())
        params = {
            "since": since,
            "limit": 100,
        }
        headers = self._get_suunto_headers()
        response = self._make_api_request(db, user_id, "/v3/workouts/", params=params, headers=headers)
        return response.get("payload", [])

    def get_workouts_from_api(self, db: DbSession, user_id: UUID, **kwargs: Any) -> Any:
        """Get workouts from Suunto API with specific options."""
        since = kwargs.get("since", 0)
        limit = kwargs.get("limit", 50)
        offset = kwargs.get("offset", 0)
        filter_by_modification_time = kwargs.get("filter_by_modification_time", True)

        params = {
            "since": since,
            "limit": min(limit, 100),
            "offset": offset,
            "filter-by-modification-time": str(filter_by_modification_time).lower(),
        }

        # Suunto requires subscription key header
        headers = self._get_suunto_headers()

        return self._make_api_request(db, user_id, "/v3/workouts/", params=params, headers=headers)

    def get_workout_detail_from_api(self, db: DbSession, user_id: UUID, workout_id: str, **kwargs: Any) -> Any:
        """Get detailed workout data from Suunto API."""
        return self.get_workout_detail(db, user_id, workout_id)

    def _extract_dates(self, start_timestamp: int, end_timestamp: int) -> tuple[datetime, datetime]:
        """Extract start and end dates from timestamps."""
        start_date = datetime.fromtimestamp(start_timestamp / 1000)
        end_date = datetime.fromtimestamp(end_timestamp / 1000)
        return start_date, end_date

    def _normalize_workout(
        self,
        raw_workout: SuuntoWorkoutJSON,
        user_id: UUID,
        metrics: dict[str, Decimal | None],
    ) -> HealthRecordCreate:
        """Normalize Suunto workout to HealthRecordCreate."""
        workout_id = uuid4()

        start_date, end_date = self._extract_dates(raw_workout.startTime, raw_workout.stopTime)
        duration_seconds = raw_workout.totalTime

        source_name = raw_workout.gear.name if raw_workout.gear else "Unknown"

        device_id = raw_workout.gear.serialNumber if raw_workout.gear else None

        return HealthRecordCreate(
            id=workout_id,
            provider_id=str(raw_workout.workoutId),
            user_id=user_id,
            type="Unknown",
            duration_seconds=Decimal(duration_seconds),
            source_name=source_name,
            device_id=device_id,
            start_datetime=start_date,
            end_datetime=end_date,
            **metrics,
        )

    def _build_metrics(self, raw_workout: SuuntoWorkoutJSON) -> dict[str, Decimal | None]:
        hr_data = raw_workout.hrdata
        heart_rate_avg = Decimal(str(hr_data.avg)) if hr_data and hr_data.avg is not None else None
        heart_rate_max = Decimal(str(hr_data.max)) if hr_data and hr_data.max is not None else None
        steps_value = Decimal(str(raw_workout.stepCount)) if raw_workout.stepCount is not None else None

        return {
            "heart_rate_min": heart_rate_avg,
            "heart_rate_max": heart_rate_max,
            "heart_rate_avg": heart_rate_avg,
            "steps_min": steps_value,
            "steps_max": steps_value,
            "steps_avg": steps_value,
        }

    def _build_bundles(
        self,
        raw: list[SuuntoWorkoutJSON],
        user_id: UUID,
    ) -> Iterable[HealthRecordCreate]:
        """Build health record payloads for Suunto workouts."""
        for raw_workout in raw:
            metrics = self._build_metrics(raw_workout)
            yield self._normalize_workout(raw_workout, user_id, metrics)

    def load_data(
        self,
        db: DbSession,
        user_id: UUID,
        **kwargs: Any,
    ) -> bool:
        """Load data from Suunto API."""
        response = self.get_workouts_from_api(db, user_id, **kwargs)
        workouts_data = response.get("payload", [])
        workouts = [SuuntoWorkoutJSON(**w) for w in workouts_data]

        for record in self._build_bundles(workouts, user_id):
            workout_service.create(db, record)

        return True

    def get_workout_detail(
        self,
        db: DbSession,
        user_id: UUID,
        workout_key: str,
    ) -> dict:
        """Get detailed workout data from Suunto API."""
        headers = self._get_suunto_headers()
        return self._make_api_request(db, user_id, f"/v3/workouts/{workout_key}", headers=headers)
