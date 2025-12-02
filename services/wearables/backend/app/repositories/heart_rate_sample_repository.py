from sqlalchemy import desc

from app.database import DbSession
from app.models import HeartRateSample
from app.repositories.repositories import CrudRepository
from app.schemas import HeartRateSampleCreate, TimeSeriesQueryParams


class HeartRateSampleRepository(CrudRepository[HeartRateSample, HeartRateSampleCreate, HeartRateSampleCreate]):
    def __init__(self, model: type[HeartRateSample]):
        super().__init__(model)

    def get_samples(
        self,
        db_session: DbSession,
        params: TimeSeriesQueryParams,
    ) -> list[HeartRateSample]:
        query = db_session.query(self.model)

        if params.device_id:
            query = query.filter(self.model.device_id == params.device_id)
        else:
            return []

        if params.start_datetime:
            query = query.filter(self.model.recorded_at >= params.start_datetime)

        if params.end_datetime:
            query = query.filter(self.model.recorded_at <= params.end_datetime)

        return query.order_by(desc(self.model.recorded_at)).limit(1000).all()

