from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import BaseDbModel
from app.mappings import FKEventRecord, ManyToOne, PrimaryKey, str_64

if TYPE_CHECKING:  # pragma: no cover
    from .event_record import EventRecord


class EventRecordDetail(BaseDbModel):
    """Base polymorphic detail model used by specific aggregates (workout, sleep, etc.)."""

    __tablename__ = "event_record_detail"

    record_id: Mapped[PrimaryKey[UUID]] = mapped_column(FKEventRecord)
    detail_type: Mapped[str_64]

    record: Mapped[ManyToOne["EventRecord"]] = relationship(back_populates="detail")

    __mapper_args__ = {
        "polymorphic_on": detail_type,
        "polymorphic_identity": "base",
    }

