from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel


class BodyStateBase(BaseModel):
    height_cm: Decimal | None = None
    weight_kg: Decimal | None = None
    body_fat_percentage: Decimal | None = None
    resting_heart_rate: Decimal | None = None


class BodyStateCreate(BodyStateBase):
    id: UUID
    user_id: UUID


class BodyStateUpdate(BodyStateBase):
    pass


class BodyStateResponse(BodyStateBase):
    id: UUID
    user_id: UUID
