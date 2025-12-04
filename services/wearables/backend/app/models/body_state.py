from uuid import UUID

from sqlalchemy.orm import Mapped

from app.database import BaseDbModel
from app.mappings import FKUser, PrimaryKey, numeric_10_3


class BodyState(BaseDbModel):
    """Slow-changing physical body measurements captured as separate observations."""

    __tablename__ = "body_state"

    id: Mapped[PrimaryKey[UUID]]
    user_id: Mapped[FKUser]

    height_cm: Mapped[numeric_10_3 | None] = None
    weight_kg: Mapped[numeric_10_3 | None] = None
    body_fat_percentage: Mapped[numeric_10_3 | None] = None
    resting_heart_rate: Mapped[numeric_10_3 | None] = None

