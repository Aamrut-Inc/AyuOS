from __future__ import annotations

from decimal import Decimal
from typing import Optional
from uuid import UUID

from pydantic import BaseModel


class BodyStateBase(BaseModel):
    height_cm: Optional[Decimal] = None
    weight_kg: Optional[Decimal] = None
    body_fat_percentage: Optional[Decimal] = None
    resting_heart_rate: Optional[Decimal] = None


class BodyStateCreate(BodyStateBase):
    id: UUID
    user_id: UUID


class BodyStateUpdate(BodyStateBase): ...


class BodyStateResponse(BodyStateBase):
    id: UUID
    user_id: UUID
