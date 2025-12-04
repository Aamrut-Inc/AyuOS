from __future__ import annotations

from uuid import UUID

from sqlalchemy import Index
from sqlalchemy.orm import Mapped

from app.database import BaseDbModel
from app.mappings import PrimaryKey, datetime_tz, numeric_10_3, str_100
from app.schemas.time_series import SeriesType


class DataPointSeries(BaseDbModel):
    """Unified time-series data points for device metrics (heart rate, steps, energy, etc.)."""

    __tablename__ = "data_point_series"
    __table_args__ = (
        Index("idx_data_point_series_device_type_time", "device_id", "series_type", "recorded_at"),
    )

    id: Mapped[PrimaryKey[UUID]]
    device_id: Mapped[str_100 | None] = None
    recorded_at: Mapped[datetime_tz]
    value: Mapped[numeric_10_3]
    series_type: Mapped[SeriesType]

