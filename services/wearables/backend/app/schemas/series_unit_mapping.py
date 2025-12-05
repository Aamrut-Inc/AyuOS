from uuid import UUID, uuid4

from pydantic import BaseModel, Field

from app.schemas.time_series import SeriesType


class SeriesUnitMappingBase(BaseModel):
    series_type: SeriesType
    unit: str = Field(description="Unit label associated with the series type (e.g. bpm, steps).")


class SeriesUnitMappingCreate(SeriesUnitMappingBase):
    id: UUID = Field(default_factory=uuid4)


class SeriesUnitMappingUpdate(SeriesUnitMappingBase):
    pass


class SeriesUnitMappingResponse(SeriesUnitMappingBase):
    id: UUID

    class Config:
        from_attributes = True

