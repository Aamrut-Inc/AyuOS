from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, Field


class TimeSeriesQueryParams(BaseModel):
    """Filters for retrieving time series samples."""

    start_datetime: datetime | None = Field(None, description="Lower bound (inclusive) for recorded timestamp")
    end_datetime: datetime | None = Field(None, description="Upper bound (inclusive) for recorded timestamp")
    device_id: str | None = Field(
        None,
        description="Device identifier filter; required to retrieve samples",
    )


class _TimeSeriesSampleBase(BaseModel):
    id: UUID
    device_id: str | None = None
    recorded_at: datetime
    value: Decimal | float | int


class HeartRateSampleCreate(_TimeSeriesSampleBase):
    """Create payload for heart rate samples."""


class HeartRateSampleResponse(_TimeSeriesSampleBase):
    """Response payload for heart rate samples."""


class StepSampleCreate(_TimeSeriesSampleBase):
    """Create payload for step count samples."""


class StepSampleResponse(_TimeSeriesSampleBase):
    """Response payload for step count samples."""

