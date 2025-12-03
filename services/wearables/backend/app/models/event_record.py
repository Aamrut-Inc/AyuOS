from __future__ import annotations

from typing import TYPE_CHECKING, Any
from uuid import UUID

from sqlalchemy import Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey, datetime_tz, numeric_10_3, str_64, str_100

if TYPE_CHECKING:  # pragma: no cover
    from .event_record_detail import EventRecordDetail
    from .sleep_details import SleepDetails
    from .workout_details import WorkoutDetails


class EventRecord(BaseDbModel):
    __tablename__ = "event_record"
    __table_args__ = (
        Index("idx_event_record_user_category", "user_id", "category"),
        Index("idx_event_record_time", "user_id", "start_datetime", "end_datetime"),
    )

    id: Mapped[PrimaryKey[UUID]]
    provider_id: Mapped[str_100 | None] = None
    user_id: Mapped[FKUser]

    category: Mapped[str_64] = mapped_column(default="workout")
    type: Mapped[str_100 | None] = None
    source_name: Mapped[str_100]
    device_id: Mapped[str_100 | None] = None

    duration_seconds: Mapped[numeric_10_3 | None] = None

    start_datetime: Mapped[datetime_tz]
    end_datetime: Mapped[datetime_tz]

    detail: Mapped["EventRecordDetail | None"] = relationship(
        "EventRecordDetail",
        back_populates="record",
        uselist=False,
        cascade="all, delete-orphan",
    )

    _WORKOUT_DETAIL_FIELDS = {
        "heart_rate_min",
        "heart_rate_max",
        "heart_rate_avg",
        "steps_min",
        "steps_max",
        "steps_avg",
        "max_speed",
        "max_watts",
        "moving_time_seconds",
        "total_elevation_gain",
        "average_speed",
        "average_watts",
        "elev_high",
        "elev_low",
    }

    _SLEEP_DETAIL_FIELDS = {
        "sleep_total_duration_minutes",
        "sleep_time_in_bed_minutes",
        "sleep_efficiency_score",
        "sleep_deep_minutes",
        "sleep_rem_minutes",
        "sleep_light_minutes",
        "sleep_awake_minutes",
    }

    def __init__(self, **kwargs: Any):
        workout_values = {
            field: kwargs.pop(field)
            for field in list(kwargs.keys())
            if field in self._WORKOUT_DETAIL_FIELDS
        }
        sleep_values = {
            field: kwargs.pop(field)
            for field in list(kwargs.keys())
            if field in self._SLEEP_DETAIL_FIELDS
        }

        super().__init__(**kwargs)

        for field, value in workout_values.items():
            setattr(self, field, value)
        for field, value in sleep_values.items():
            setattr(self, field, value)

    # ------------------------------------------------------------------ Detail helpers
    def _get_workout_detail(self) -> "WorkoutDetails | None":
        from .workout_details import WorkoutDetails

        detail = self.detail
        return detail if isinstance(detail, WorkoutDetails) else None

    def _ensure_workout_detail(self) -> "WorkoutDetails":
        from .workout_details import WorkoutDetails

        detail = self._get_workout_detail()
        if detail is None:
            detail = WorkoutDetails()
            self.detail = detail
        return detail

    def _get_sleep_detail(self) -> "SleepDetails | None":
        from .sleep_details import SleepDetails

        detail = self.detail
        return detail if isinstance(detail, SleepDetails) else None

    def _ensure_sleep_detail(self) -> "SleepDetails":
        from .sleep_details import SleepDetails

        detail = self._get_sleep_detail()
        if detail is None:
            detail = SleepDetails()
            self.detail = detail
        return detail

    # ------------------------------------------------------------------ Workout proxies
    @property
    def heart_rate_min(self):
        detail = self._get_workout_detail()
        return detail.heart_rate_min if detail else None

    @heart_rate_min.setter
    def heart_rate_min(self, value):
        if value is None:
            detail = self._get_workout_detail()
            if detail:
                detail.heart_rate_min = None
            return
        self._ensure_workout_detail().heart_rate_min = value

    @property
    def heart_rate_max(self):
        detail = self._get_workout_detail()
        return detail.heart_rate_max if detail else None

    @heart_rate_max.setter
    def heart_rate_max(self, value):
        if value is None:
            detail = self._get_workout_detail()
            if detail:
                detail.heart_rate_max = None
            return
        self._ensure_workout_detail().heart_rate_max = value

    @property
    def heart_rate_avg(self):
        detail = self._get_workout_detail()
        return detail.heart_rate_avg if detail else None

    @heart_rate_avg.setter
    def heart_rate_avg(self, value):
        if value is None:
            detail = self._get_workout_detail()
            if detail:
                detail.heart_rate_avg = None
            return
        self._ensure_workout_detail().heart_rate_avg = value

    @property
    def steps_min(self):
        detail = self._get_workout_detail()
        return detail.steps_min if detail else None

    @steps_min.setter
    def steps_min(self, value):
        if value is None:
            detail = self._get_workout_detail()
            if detail:
                detail.steps_min = None
            return
        self._ensure_workout_detail().steps_min = value

    @property
    def steps_max(self):
        detail = self._get_workout_detail()
        return detail.steps_max if detail else None

    @steps_max.setter
    def steps_max(self, value):
        if value is None:
            detail = self._get_workout_detail()
            if detail:
                detail.steps_max = None
            return
        self._ensure_workout_detail().steps_max = value

    @property
    def steps_avg(self):
        detail = self._get_workout_detail()
        return detail.steps_avg if detail else None

    @steps_avg.setter
    def steps_avg(self, value):
        if value is None:
            detail = self._get_workout_detail()
            if detail:
                detail.steps_avg = None
            return
        self._ensure_workout_detail().steps_avg = value

    # Advanced workout metrics
    @staticmethod
    def _workout_metric_property(field_name: str):
        def getter(self):
            detail = self._get_workout_detail()
            return getattr(detail, field_name) if detail else None

        def setter(self, value):
            if value is None:
                detail = self._get_workout_detail()
                if detail:
                    setattr(detail, field_name, None)
                return
            setattr(self._ensure_workout_detail(), field_name, value)

        return property(getter, setter)

    max_speed = _workout_metric_property("max_speed")
    max_watts = _workout_metric_property("max_watts")
    moving_time_seconds = _workout_metric_property("moving_time_seconds")
    total_elevation_gain = _workout_metric_property("total_elevation_gain")
    average_speed = _workout_metric_property("average_speed")
    average_watts = _workout_metric_property("average_watts")
    elev_high = _workout_metric_property("elev_high")
    elev_low = _workout_metric_property("elev_low")

    # ------------------------------------------------------------------ Sleep metrics
    @staticmethod
    def _sleep_metric_property(field_name: str):
        def getter(self):
            detail = self._get_sleep_detail()
            return getattr(detail, field_name) if detail else None

        def setter(self, value):
            if value is None:
                detail = self._get_sleep_detail()
                if detail:
                    setattr(detail, field_name, None)
                return
            setattr(self._ensure_sleep_detail(), field_name, value)

        return property(getter, setter)

    sleep_total_duration_minutes = _sleep_metric_property("sleep_total_duration_minutes")
    sleep_time_in_bed_minutes = _sleep_metric_property("sleep_time_in_bed_minutes")
    sleep_efficiency_score = _sleep_metric_property("sleep_efficiency_score")
    sleep_deep_minutes = _sleep_metric_property("sleep_deep_minutes")
    sleep_rem_minutes = _sleep_metric_property("sleep_rem_minutes")
    sleep_light_minutes = _sleep_metric_property("sleep_light_minutes")
    sleep_awake_minutes = _sleep_metric_property("sleep_awake_minutes")
