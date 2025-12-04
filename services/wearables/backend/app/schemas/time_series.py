from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


class SeriesType(str, Enum):
    steps = "steps"
    heart_rate = "heart_rate"
    energy = "energy"


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
    series_type: SeriesType


class TimeSeriesSampleCreate(_TimeSeriesSampleBase):
    """Generic create payload for data point series."""


class TimeSeriesSampleResponse(_TimeSeriesSampleBase):
    """Generic response payload for data point series."""


class HeartRateSampleCreate(TimeSeriesSampleCreate):
    """Create payload for heart rate samples."""

    series_type: SeriesType = Field(default=SeriesType.heart_rate)


class HeartRateSampleResponse(TimeSeriesSampleResponse):
    """Response payload for heart rate samples."""

    series_type: SeriesType = Field(default=SeriesType.heart_rate)


class StepSampleCreate(TimeSeriesSampleCreate):
    """Create payload for step count samples."""

    series_type: SeriesType = Field(default=SeriesType.steps)


class StepSampleResponse(TimeSeriesSampleResponse):
    """Response payload for step count samples."""

    series_type: SeriesType = Field(default=SeriesType.steps)
