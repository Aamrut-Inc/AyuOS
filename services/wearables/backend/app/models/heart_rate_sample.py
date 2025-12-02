from uuid import UUID

from sqlalchemy import Index
from sqlalchemy.orm import Mapped

from app.database import BaseDbModel
from app.mappings import PrimaryKey, datetime_tz, numeric_10_3, str_100


class HeartRateSample(BaseDbModel):
    __tablename__ = "heart_rate_sample"
    __table_args__ = (
        Index("idx_hr_sample_device_time", "device_id", "recorded_at"),
    )

    id: Mapped[PrimaryKey[UUID]]
    device_id: Mapped[str_100 | None] = None
    recorded_at: Mapped[datetime_tz]
    value: Mapped[numeric_10_3]

