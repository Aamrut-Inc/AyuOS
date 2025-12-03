from decimal import Decimal
from uuid import UUID

import isodate
from sqlalchemy import and_, desc
from sqlalchemy.orm import Query

from app.database import DbSession
from app.models import EventRecord
from app.repositories.repositories import CrudRepository
from app.schemas import EventRecordCreate, EventRecordQueryParams, EventRecordUpdate


class EventRecordRepository(
    CrudRepository[EventRecord, EventRecordCreate, EventRecordUpdate],
):
    def __init__(self, model: type[EventRecord]):
        super().__init__(model)

    def get_records_with_filters(
        self,
        db_session: DbSession,
        query_params: EventRecordQueryParams,
        user_id: str,
    ) -> tuple[list[EventRecord], int]:
        query: Query = db_session.query(EventRecord)

        filters = [EventRecord.user_id == UUID(user_id)]

        if query_params.category:
            filters.append(EventRecord.category == query_params.category)

        if query_params.record_type:
            filters.append(EventRecord.type.ilike(f"%{query_params.record_type}%"))

        if query_params.source_name:
            filters.append(EventRecord.source_name.ilike(f"%{query_params.source_name}%"))

        if query_params.device_id:
            filters.append(EventRecord.device_id == query_params.device_id)

        if query_params.start_date:
            start_dt = isodate.parse_datetime(query_params.start_date)
            filters.append(EventRecord.start_datetime >= start_dt)

        if query_params.end_date:
            end_dt = isodate.parse_datetime(query_params.end_date)
            filters.append(EventRecord.end_datetime <= end_dt)

        if query_params.min_duration is not None:
            filters.append(EventRecord.duration_seconds >= Decimal(query_params.min_duration))

        if query_params.max_duration is not None:
            filters.append(EventRecord.duration_seconds <= Decimal(query_params.max_duration))

        if filters:
            query = query.filter(and_(*filters))

        total_count = query.count()

        sort_column = getattr(EventRecord, query_params.sort_by or "start_datetime")
        query = query.order_by(sort_column) if query_params.sort_order == "asc" else query.order_by(desc(sort_column))

        query = query.offset(query_params.offset).limit(query_params.limit)

        return query.all(), total_count
