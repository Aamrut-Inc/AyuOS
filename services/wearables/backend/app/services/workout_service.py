from logging import Logger, getLogger

from app.database import DbSession
from app.models import EventRecord
from app.repositories import EventRecordRepository
from app.schemas import (
    EventRecordCreate,
    EventRecordQueryParams,
    EventRecordResponse,
    EventRecordUpdate,
)
from app.services.services import AppService
from app.utils.exceptions import handle_exceptions


class EventRecordService(
    AppService[EventRecordRepository, EventRecord, EventRecordCreate, EventRecordUpdate],
):
    """Service coordinating CRUD access for unified health records."""

    def __init__(self, log: Logger, **kwargs):
        super().__init__(crud_model=EventRecordRepository, model=EventRecord, log=log, **kwargs)

    @handle_exceptions
    async def _get_records_with_filters(
        self,
        db_session: DbSession,
        query_params: EventRecordQueryParams,
        user_id: str,
    ) -> tuple[list[EventRecord], int]:
        self.logger.debug(f"Fetching event records with filters: {query_params.model_dump()}")

        records, total_count = self.crud.get_records_with_filters(db_session, query_params, user_id)

        self.logger.debug(f"Retrieved {len(records)} event records out of {total_count} total")

        return records, total_count

    @handle_exceptions
    async def get_records_response(
        self,
        db_session: DbSession,
        query_params: EventRecordQueryParams,
        user_id: str,
    ) -> list[EventRecordResponse]:
        records, _ = await self._get_records_with_filters(db_session, query_params, user_id)

        return [
            EventRecordResponse(
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
                max_speed=record.max_speed,
                max_watts=record.max_watts,
                moving_time_seconds=record.moving_time_seconds,
                total_elevation_gain=record.total_elevation_gain,
                average_speed=record.average_speed,
                average_watts=record.average_watts,
                elev_high=record.elev_high,
                elev_low=record.elev_low,
                sleep_total_duration_minutes=record.sleep_total_duration_minutes,
                sleep_time_in_bed_minutes=record.sleep_time_in_bed_minutes,
                sleep_efficiency_score=record.sleep_efficiency_score,
                sleep_deep_minutes=record.sleep_deep_minutes,
                sleep_rem_minutes=record.sleep_rem_minutes,
                sleep_light_minutes=record.sleep_light_minutes,
                sleep_awake_minutes=record.sleep_awake_minutes,
            )
            for record in records
        ]


event_record_service = EventRecordService(log=getLogger(__name__))
# Backwards compatible alias until routes are renamed
workout_service = event_record_service
