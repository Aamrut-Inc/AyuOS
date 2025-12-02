from logging import Logger, getLogger

from app.database import DbSession
from app.models import HealthRecord
from app.repositories import HealthRecordRepository
from app.schemas import (
    HealthRecordCreate,
    HealthRecordQueryParams,
    HealthRecordResponse,
    HealthRecordUpdate,
)
from app.services.services import AppService
from app.utils.exceptions import handle_exceptions


class HealthRecordService(
    AppService[HealthRecordRepository, HealthRecord, HealthRecordCreate, HealthRecordUpdate],
):
    """Service coordinating CRUD access for unified health records."""

    def __init__(self, log: Logger, **kwargs):
        super().__init__(crud_model=HealthRecordRepository, model=HealthRecord, log=log, **kwargs)

    @handle_exceptions
    async def _get_records_with_filters(
        self,
        db_session: DbSession,
        query_params: HealthRecordQueryParams,
        user_id: str,
    ) -> tuple[list[HealthRecord], int]:
        self.logger.debug(f"Fetching health records with filters: {query_params.model_dump()}")

        records, total_count = self.crud.get_records_with_filters(db_session, query_params, user_id)

        self.logger.debug(f"Retrieved {len(records)} health records out of {total_count} total")

        return records, total_count

    @handle_exceptions
    async def get_records_response(
        self,
        db_session: DbSession,
        query_params: HealthRecordQueryParams,
        user_id: str,
    ) -> list[HealthRecordResponse]:
        records, _ = await self._get_records_with_filters(db_session, query_params, user_id)

        return [
            HealthRecordResponse(
                id=record.id,
                user_id=record.user_id,
                provider_id=record.provider_id,
                category=record.category,
                type=record.type,
                source_name=record.source_name,
                device_id=record.device_id,
                duration_seconds=record.duration_seconds,
                start_datetime=record.start_datetime,
                end_datetime=record.end_datetime,
                heart_rate_min=record.heart_rate_min,
                heart_rate_max=record.heart_rate_max,
                heart_rate_avg=record.heart_rate_avg,
                steps_min=record.steps_min,
                steps_max=record.steps_max,
                steps_avg=record.steps_avg,
            )
            for record in records
        ]


health_record_service = HealthRecordService(log=getLogger(__name__))
# Backwards compatible alias until routes are renamed
workout_service = health_record_service
