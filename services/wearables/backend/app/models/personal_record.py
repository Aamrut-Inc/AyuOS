from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from datetime import date

from sqlalchemy import UniqueConstraint, Date
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey, str_64

if TYPE_CHECKING:  # pragma: no cover
    from .user import User


class PersonalRecord(BaseDbModel):
    """Slow-changing physical attributes linked to a user."""

    __tablename__ = "personal_record"
    __table_args__ = (
        UniqueConstraint("user_id", name="uq_personal_record_user_id"),
    )

    id: Mapped[PrimaryKey[UUID]]
    user_id: Mapped[FKUser]

    birth_date: Mapped[date | None] = mapped_column(Date)
    gender: Mapped[str_64 | None] = None

    user: Mapped["User"] = relationship(back_populates="personal_record")

