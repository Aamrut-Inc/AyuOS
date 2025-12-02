from logging import Logger, getLogger

from app.database import DbSession
from app.models import HeartRateSample, StepSample
from app.repositories import HeartRateSampleRepository, StepSampleRepository
from app.schemas import HeartRateSampleCreate, HeartRateSampleResponse, StepSampleCreate, StepSampleResponse, TimeSeriesQueryParams
from app.utils.exceptions import handle_exceptions


class TimeSeriesService:
    """Coordinated access to heart-rate and step time series samples."""

    def __init__(self, log: Logger):
        self.logger = log
        self.heart_rate_repo = HeartRateSampleRepository(HeartRateSample)
        self.step_repo = StepSampleRepository(StepSample)

    def create_heart_rate_sample(self, db_session: DbSession, sample: HeartRateSampleCreate) -> HeartRateSample:
        created = self.heart_rate_repo.create(db_session, sample)
        self.logger.debug(f"Stored heart rate sample {created.id}")
        return created

    def create_step_sample(self, db_session: DbSession, sample: StepSampleCreate) -> StepSample:
        created = self.step_repo.create(db_session, sample)
        self.logger.debug(f"Stored step sample {created.id}")
        return created

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
        samples = self.heart_rate_repo.get_samples(db_session, params)
        return [
            HeartRateSampleResponse(
                id=sample.id,
                device_id=sample.device_id,
                recorded_at=sample.recorded_at,
                value=sample.value,
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
        samples = self.step_repo.get_samples(db_session, params)
        return [
            StepSampleResponse(
                id=sample.id,
                device_id=sample.device_id,
                recorded_at=sample.recorded_at,
                value=sample.value,
            )
            for sample in samples
        ]


time_series_service = TimeSeriesService(log=getLogger(__name__))
workout_statistic_service = time_series_service
