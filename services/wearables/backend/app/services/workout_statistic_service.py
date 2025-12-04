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
)
from app.utils.exceptions import handle_exceptions


class TimeSeriesService:
    """Coordinated access to unified device time series samples."""

    HEART_RATE_TYPE = SeriesType.heart_rate
    STEP_TYPE = SeriesType.steps

    def __init__(self, log: Logger):
        self.logger = log
        self.repo = DataPointSeriesRepository(DataPointSeries)

    def _create_sample(self, db_session: DbSession, sample: TimeSeriesSampleCreate) -> DataPointSeries:
        created = self.repo.create(db_session, sample)
        self.logger.debug(
            "Stored %s data point %s",
            sample.series_type,
            created.id,
        )
        return created

    def create_heart_rate_sample(self, db_session: DbSession, sample: HeartRateSampleCreate) -> DataPointSeries:
        return self._create_sample(db_session, sample)

    def create_step_sample(self, db_session: DbSession, sample: StepSampleCreate) -> DataPointSeries:
        return self._create_sample(db_session, sample)

    def bulk_create_heart_rate_samples(self, db_session: DbSession, samples: list[HeartRateSampleCreate]) -> None:
        for sample in samples:
            self.create_heart_rate_sample(db_session, sample)

    def bulk_create_step_samples(self, db_session: DbSession, samples: list[StepSampleCreate]) -> None:
        for sample in samples:
            self.create_step_sample(db_session, sample)

    @handle_exceptions
    async def get_user_heart_rate_series(
        self,
        db_session: DbSession,
        _user_id: str,
        params: TimeSeriesQueryParams,
    ) -> list[HeartRateSampleResponse]:
        samples = self.repo.get_samples(db_session, params, self.HEART_RATE_TYPE)
        return [
            HeartRateSampleResponse(
                id=sample.id,
                device_id=sample.device_id,
                recorded_at=sample.recorded_at,
                value=sample.value,
                series_type=self.HEART_RATE_TYPE,
            )
            for sample in samples
        ]

    @handle_exceptions
    async def get_user_step_series(
        self,
        db_session: DbSession,
        _user_id: str,
        params: TimeSeriesQueryParams,
    ) -> list[StepSampleResponse]:
        samples = self.repo.get_samples(db_session, params, self.STEP_TYPE)
        return [
            StepSampleResponse(
                id=sample.id,
                device_id=sample.device_id,
                recorded_at=sample.recorded_at,
                value=sample.value,
                series_type=self.STEP_TYPE,
            )
            for sample in samples
        ]


time_series_service = TimeSeriesService(log=getLogger(__name__))
workout_statistic_service = time_series_service
