from sqlalchemy.orm import Mapped

from app.database import BaseDbModel
from app.mappings import PrimaryKey, Unique, str_10,str_32


class SeriesTypeDefinition(BaseDbModel):
    """Defines the available time-series types and their canonical units."""

    __tablename__ = "series_type_definition"

    id: Mapped[PrimaryKey[int]]
    code: Mapped[Unique[str_32]]
    unit: Mapped[str_10]

