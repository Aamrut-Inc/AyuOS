from uuid import UUID

from sqlalchemy import Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey, datetime_tz, numeric_10_3, str_64, str_100


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
