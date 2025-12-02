from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field

from app.schemas.common import BaseQueryParams


class HealthRecordCreate(BaseModel):
    """Schema for creating a health record entry."""

    id: UUID
    provider_id: str | None = None
    user_id: UUID

    category: str = Field("workout", description="High-level category such as workout or sleep")
    type: str | None = Field(None, description="Provider-specific subtype, e.g. running")
    source_name: str
    device_id: str | None = Field(None, description="Optional device identifier")

    duration_seconds: Decimal | None = None
    start_datetime: datetime
    end_datetime: datetime

    heart_rate_min: Decimal | None = None
    heart_rate_max: Decimal | None = None
    heart_rate_avg: Decimal | None = None
    steps_min: Decimal | None = None
    steps_max: Decimal | None = None
    steps_avg: Decimal | None = None


class HealthRecordUpdate(BaseModel):
    """Schema for updating a health record."""

    category: str | None = None
    type: str | None = None
    source_name: str | None = None
    device_id: str | None = None

    duration_seconds: Decimal | None = None
    start_datetime: datetime | None = None
    end_datetime: datetime | None = None

    heart_rate_min: Decimal | None = None
    heart_rate_max: Decimal | None = None
    heart_rate_avg: Decimal | None = None
    steps_min: Decimal | None = None
    steps_max: Decimal | None = None
    steps_avg: Decimal | None = None


class HealthRecordResponse(BaseModel):
    """Schema returned to API consumers."""

    id: UUID
    user_id: UUID
    provider_id: str | None
    category: str
    type: str | None
    source_name: str
    device_id: str | None
    duration_seconds: Decimal | None
    start_datetime: datetime
    end_datetime: datetime
    heart_rate_min: Decimal | None
    heart_rate_max: Decimal | None
    heart_rate_avg: Decimal | None
    steps_min: Decimal | None
    steps_max: Decimal | None
    steps_avg: Decimal | None


class HealthRecordQueryParams(BaseQueryParams):
    """Filtering and sorting parameters for health records."""

    category: str | None = Field(
        "workout",
        description="Record category (workout, sleep, etc). Defaults to workout.",
    )
    record_type: str | None = Field(None, description="Subtype filter (e.g. HKWorkoutActivityTypeRunning)")
    device_id: str | None = Field(None, description="Filter by originating device id")
    source_name: str | None = Field(None, description="Filter by source/app name")
    min_duration: int | None = Field(None, description="Minimum duration in seconds")
    max_duration: int | None = Field(None, description="Maximum duration in seconds")
    sort_by: Literal[
        "start_datetime",
        "end_datetime",
        "duration_seconds",
        "type",
        "source_name",
    ] | None = Field(
        "start_datetime",
        description="Sort field",
    )

