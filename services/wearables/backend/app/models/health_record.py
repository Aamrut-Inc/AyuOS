from __future__ import annotations

from uuid import UUID

from sqlalchemy import Index
from sqlalchemy.orm import Mapped, mapped_column

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey, datetime_tz, numeric_10_3, str_64, str_100


class HealthRecord(BaseDbModel):
    __tablename__ = "health_record"
    __table_args__ = (
        Index("idx_health_record_user_category", "user_id", "category"),
        Index("idx_health_record_time", "user_id", "start_datetime", "end_datetime"),
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

    heart_rate_min: Mapped[numeric_10_3 | None] = None
    heart_rate_max: Mapped[numeric_10_3 | None] = None
    heart_rate_avg: Mapped[numeric_10_3 | None] = None
    steps_min: Mapped[numeric_10_3 | None] = None
    steps_max: Mapped[numeric_10_3 | None] = None
    steps_avg: Mapped[numeric_10_3 | None] = None


