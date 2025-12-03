from __future__ import annotations

from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class PersonalRecordBase(BaseModel):
    age_years: int | None = Field(None, ge=0, description="Approximate age in years")
    height_cm: Decimal | None = Field(None, description="Height in centimeters")
    weight_kg: Decimal | None = Field(None, description="Weight in kilograms")
    gender: Literal["female", "male", "nonbinary", "other"] | None = Field(
        None,
        description="Optional self-reported gender",
    )
    body_fat_percentage: Decimal | None = None
    resting_heart_rate: Decimal | None = None


class PersonalRecordCreate(PersonalRecordBase):
    id: UUID
    user_id: UUID


class PersonalRecordUpdate(PersonalRecordBase): ...


class PersonalRecordResponse(PersonalRecordBase):
    id: UUID
    user_id: UUID
