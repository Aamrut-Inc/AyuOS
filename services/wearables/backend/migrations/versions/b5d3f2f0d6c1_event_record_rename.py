"""rename health_record to event_record

Revision ID: b5d3f2f0d6c1
Revises: a1db66fde2ce
"""

from typing import Sequence, Union

from alembic import op

revision: str = "b5d3f2f0d6c1"
down_revision: Union[str, None] = "a1db66fde2ce"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.rename_table("health_record", "event_record")
    op.execute(
        "ALTER INDEX idx_health_record_user_category RENAME TO idx_event_record_user_category",
    )
    op.execute(
        "ALTER INDEX idx_health_record_time RENAME TO idx_event_record_time",
    )

    op.rename_table("health_record_detail", "event_record_detail")


def downgrade() -> None:
    op.rename_table("event_record_detail", "health_record_detail")

    op.execute(
        "ALTER INDEX idx_event_record_user_category RENAME TO idx_health_record_user_category",
    )
    op.execute(
        "ALTER INDEX idx_event_record_time RENAME TO idx_health_record_time",
    )
    op.rename_table("event_record", "health_record")

