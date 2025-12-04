"""unify heart rate and step samples into data_point_series

Revision ID: d2a7b13dbfea
Revises: c53a9a1517f3
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "d2a7b13dbfea"
down_revision: Union[str, None] = "c53a9a1517f3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "data_point_series",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("device_id", sa.String(length=100), nullable=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value", sa.Numeric(10, 3), nullable=False),
        sa.Column("series_type", sa.String(length=64), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_data_point_series_device_type_time",
        "data_point_series",
        ["device_id", "series_type", "recorded_at"],
    )

    op.execute(
        """
        INSERT INTO data_point_series (id, device_id, recorded_at, value, series_type)
        SELECT id, device_id, recorded_at, value, 'heart_rate'
        FROM heart_rate_sample
        """,
    )
    op.execute(
        """
        INSERT INTO data_point_series (id, device_id, recorded_at, value, series_type)
        SELECT id, device_id, recorded_at, value, 'steps'
        FROM step_sample
        """,
    )

    op.drop_table("heart_rate_sample")
    op.drop_table("step_sample")


def downgrade() -> None:
    op.create_table(
        "heart_rate_sample",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("device_id", sa.String(length=100), nullable=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value", sa.Numeric(10, 3), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_hr_sample_device_time",
        "heart_rate_sample",
        ["device_id", "recorded_at"],
    )

    op.create_table(
        "step_sample",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("device_id", sa.String(length=100), nullable=True),
        sa.Column("recorded_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("value", sa.Numeric(10, 3), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_step_sample_device_time",
        "step_sample",
        ["device_id", "recorded_at"],
    )

    op.execute(
        """
        INSERT INTO heart_rate_sample (id, device_id, recorded_at, value)
        SELECT id, device_id, recorded_at, value
        FROM data_point_series
        WHERE series_type = 'heart_rate'
        """,
    )
    op.execute(
        """
        INSERT INTO step_sample (id, device_id, recorded_at, value)
        SELECT id, device_id, recorded_at, value
        FROM data_point_series
        WHERE series_type = 'steps'
        """,
    )

    op.drop_index("idx_data_point_series_device_type_time", table_name="data_point_series")
    op.drop_table("data_point_series")

