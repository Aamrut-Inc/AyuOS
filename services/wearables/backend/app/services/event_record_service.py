from logging import Logger, getLogger

from app.database import DbSession
from app.models import EventRecord, EventRecordDetail
from app.repositories import EventRecordRepository, EventRecordDetailRepository
from app.schemas import (
    EventRecordCreate,
    EventRecordQueryParams,
    EventRecordResponse,
    EventRecordUpdate,
    EventRecordDetailCreate,
)
from app.services.services import AppService
from app.utils.exceptions import handle_exceptions


class EventRecordService(
    AppService[EventRecordRepository, EventRecord, EventRecordCreate, EventRecordUpdate],
):
    """Service coordinating CRUD access for unified health records."""

    def __init__(self, log: Logger, **kwargs):
        super().__init__(crud_model=EventRecordRepository, model=EventRecord, log=log, **kwargs)

    def create_detail(self, db_session: DbSession, detail: EventRecordDetailCreate) -> EventRecordDetail:
        repo = EventRecordDetailRepository(EventRecordDetail)
        return repo.create(db_session, detail)

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

        return [EventRecordResponse(**record.model_dump()) for record in records]


event_record_service = EventRecordService(log=getLogger(__name__))