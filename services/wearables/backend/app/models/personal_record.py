from __future__ import annotations

from typing import TYPE_CHECKING
from uuid import UUID

from sqlalchemy import Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey, numeric_10_3, str_64

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

    age_years: Mapped[int | None] = mapped_column(Integer)
    height_cm: Mapped[numeric_10_3 | None] = None
    weight_kg: Mapped[numeric_10_3 | None] = None
    gender: Mapped[str_64 | None] = None
    body_fat_percentage: Mapped[numeric_10_3 | None] = None
    resting_heart_rate: Mapped[numeric_10_3 | None] = None

    user: Mapped["User"] = relationship(back_populates="personal_record")

