from app.database import DbSession
from app.models import SeriesUnitMapping
from app.repositories.repositories import CrudRepository
from app.schemas.series_unit_mapping import SeriesUnitMappingCreate, SeriesUnitMappingUpdate
from app.schemas.time_series import SeriesType


class SeriesUnitMappingRepository(
    CrudRepository[SeriesUnitMapping, SeriesUnitMappingCreate, SeriesUnitMappingUpdate],
):
    """Persistence layer for mapping time-series types to their units."""

    def get_by_series_type(self, db_session: DbSession, series_type: SeriesType) -> SeriesUnitMapping | None:
        return (
            db_session.query(self.model)
            .filter(self.model.series_type == series_type)
            .one_or_none()
        )

    def get_all(self, db_session: DbSession) -> list[SeriesUnitMapping]:
        return db_session.query(self.model).order_by(self.model.series_type).all()

