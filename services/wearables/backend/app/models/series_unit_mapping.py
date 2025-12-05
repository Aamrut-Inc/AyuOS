from uuid import UUID

from sqlalchemy import UniqueConstraint
from sqlalchemy.orm import Mapped

from app.database import BaseDbModel
from app.mappings import PrimaryKey, str_64
from app.schemas.time_series import SeriesType


class SeriesUnitMapping(BaseDbModel):
    """Stores the display unit for each supported time series type."""

    __tablename__ = "series_unit_mapping"
    __table_args__ = (UniqueConstraint("series_type", name="uq_series_unit_series_type"),)

    id: Mapped[PrimaryKey[UUID]]
    series_type: Mapped[SeriesType]
    unit: Mapped[str_64]

