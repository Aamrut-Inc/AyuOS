from decimal import Decimal
from uuid import UUID

import isodate
from sqlalchemy import and_, desc
from sqlalchemy.orm import Query

from app.database import DbSession
from app.models import HealthRecord
from app.repositories.repositories import CrudRepository
from app.schemas import HealthRecordCreate, HealthRecordQueryParams, HealthRecordUpdate


class HealthRecordRepository(
    CrudRepository[HealthRecord, HealthRecordCreate, HealthRecordUpdate],
):
    def __init__(self, model: type[HealthRecord]):
        super().__init__(model)

    def get_records_with_filters(
        self,
        db_session: DbSession,
        query_params: HealthRecordQueryParams,
        user_id: str,
    ) -> tuple[list[HealthRecord], int]:
        query: Query = db_session.query(HealthRecord)

        filters = [HealthRecord.user_id == UUID(user_id)]

        if query_params.category:
            filters.append(HealthRecord.category == query_params.category)

        if query_params.record_type:
            filters.append(HealthRecord.type.ilike(f"%{query_params.record_type}%"))

        if query_params.source_name:
            filters.append(HealthRecord.source_name.ilike(f"%{query_params.source_name}%"))

        if query_params.device_id:
            filters.append(HealthRecord.device_id == query_params.device_id)

        if query_params.start_date:
            start_dt = isodate.parse_datetime(query_params.start_date)
            filters.append(HealthRecord.start_datetime >= start_dt)

        if query_params.end_date:
            end_dt = isodate.parse_datetime(query_params.end_date)
            filters.append(HealthRecord.end_datetime <= end_dt)

        if query_params.min_duration is not None:
            filters.append(HealthRecord.duration_seconds >= Decimal(query_params.min_duration))

        if query_params.max_duration is not None:
            filters.append(HealthRecord.duration_seconds <= Decimal(query_params.max_duration))

        if filters:
            query = query.filter(and_(*filters))

        total_count = query.count()

        sort_column = getattr(HealthRecord, query_params.sort_by or "start_datetime")
        query = query.order_by(sort_column) if query_params.sort_order == "asc" else query.order_by(desc(sort_column))

        query = query.offset(query_params.offset).limit(query_params.limit)

        return query.all(), total_count

