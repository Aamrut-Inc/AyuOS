from __future__ import annotations

from uuid import UUID

from sqlalchemy import ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.mappings import PrimaryKey, numeric_10_3
from .event_record_detail import EventRecordDetail


class SleepDetails(EventRecordDetail):
    """Per-sleep aggregates and metrics."""

    __tablename__ = "sleep_details"
    __mapper_args__ = {"polymorphic_identity": "sleep"}

    record_id: Mapped[PrimaryKey[UUID]] = mapped_column(
        ForeignKey("event_record_detail.record_id", ondelete="CASCADE"),
    )

    sleep_total_duration_minutes: Mapped[numeric_10_3 | None] = None
    sleep_time_in_bed_minutes: Mapped[numeric_10_3 | None] = None
    sleep_efficiency_score: Mapped[numeric_10_3 | None] = None
    sleep_deep_minutes: Mapped[numeric_10_3 | None] = None
    sleep_rem_minutes: Mapped[numeric_10_3 | None] = None
    sleep_light_minutes: Mapped[numeric_10_3 | None] = None
    sleep_awake_minutes: Mapped[numeric_10_3 | None] = None

