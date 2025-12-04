from logging import Logger, getLogger

from app.database import DbSession
from app.models import DataPointSeries
from app.repositories import DataPointSeriesRepository
from app.schemas import (
    HeartRateSampleCreate,
    HeartRateSampleResponse,
    SeriesType,
    StepSampleCreate,
    StepSampleResponse,
    TimeSeriesQueryParams,
    TimeSeriesSampleCreate,
    TimeSeriesSampleUpdate,
)
from app.services.services import AppService
from app.utils.exceptions import handle_exceptions


class TimeSeriesService(
    AppService[DataPointSeriesRepository, DataPointSeries, TimeSeriesSampleCreate, TimeSeriesSampleUpdate],
):
    """Coordinated access to unified device time series samples."""

    HEART_RATE_TYPE = SeriesType.heart_rate
    STEP_TYPE = SeriesType.steps

    def __init__(self, log: Logger):
        super().__init__(crud_model=DataPointSeriesRepository, model=DataPointSeries, log=log)

    def bulk_create_samples(
        self,
        db_session: DbSession,
        samples: list[TimeSeriesSampleCreate] | list[HeartRateSampleCreate] | list[StepSampleCreate],
    ) -> None:
        for sample in samples:
            self.crud.create(db_session, sample)

    @handle_exceptions
    async def get_user_heart_rate_series(
        self,
        db_session: DbSession,
        _user_id: str,
        params: TimeSeriesQueryParams,
    ) -> list[HeartRateSampleResponse]:
        samples = self.crud.get_samples(db_session, params, self.HEART_RATE_TYPE)
        return [HeartRateSampleResponse(**sample.model_dump()) for sample in samples]

    @handle_exceptions
    async def get_user_step_series(
        self,
        db_session: DbSession,
        _user_id: str,
        params: TimeSeriesQueryParams,
    ) -> list[StepSampleResponse]:
        samples = self.crud.get_samples(db_session, params, self.STEP_TYPE)
        return [StepSampleResponse(**sample.model_dump()) for sample in samples]


time_series_service = TimeSeriesService(log=getLogger(__name__))
