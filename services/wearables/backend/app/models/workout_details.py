from sqlalchemy.orm import Mapped

from app.mappings import FKEventRecordDetail, numeric_10_3
from .event_record_detail import EventRecordDetail


class WorkoutDetails(EventRecordDetail):
    """Per-workout aggregates and metrics."""

    __tablename__ = "workout_details"
    __mapper_args__ = {"polymorphic_identity": "workout"}

    record_id: Mapped[FKEventRecordDetail]

    heart_rate_min: Mapped[numeric_10_3 | None] = None
    heart_rate_max: Mapped[numeric_10_3 | None] = None
    heart_rate_avg: Mapped[numeric_10_3 | None] = None
    steps_min: Mapped[numeric_10_3 | None] = None
    steps_max: Mapped[numeric_10_3 | None] = None
    steps_avg: Mapped[numeric_10_3 | None] = None

    max_speed: Mapped[numeric_10_3 | None] = None
    max_watts: Mapped[numeric_10_3 | None] = None
    moving_time_seconds: Mapped[numeric_10_3 | None] = None
    total_elevation_gain: Mapped[numeric_10_3 | None] = None
    average_speed: Mapped[numeric_10_3 | None] = None
    average_watts: Mapped[numeric_10_3 | None] = None
    elev_high: Mapped[numeric_10_3 | None] = None
    elev_low: Mapped[numeric_10_3 | None] = None

