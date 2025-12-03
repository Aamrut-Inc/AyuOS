"""health record details tables

Revision ID: a1db66fde2ce
Revises: 17ccee003c1a
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "a1db66fde2ce"
down_revision: Union[str, None] = "17ccee003c1a"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "health_record_detail",
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("detail_type", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(["record_id"], ["health_record.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("record_id"),
    )

    op.create_table(
        "workout_details",
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("heart_rate_min", sa.Numeric(10, 3), nullable=True),
        sa.Column("heart_rate_max", sa.Numeric(10, 3), nullable=True),
        sa.Column("heart_rate_avg", sa.Numeric(10, 3), nullable=True),
        sa.Column("steps_min", sa.Numeric(10, 3), nullable=True),
        sa.Column("steps_max", sa.Numeric(10, 3), nullable=True),
        sa.Column("steps_avg", sa.Numeric(10, 3), nullable=True),
        sa.Column("max_speed", sa.Numeric(10, 3), nullable=True),
        sa.Column("max_watts", sa.Numeric(10, 3), nullable=True),
        sa.Column("moving_time_seconds", sa.Numeric(10, 3), nullable=True),
        sa.Column("total_elevation_gain", sa.Numeric(10, 3), nullable=True),
        sa.Column("average_speed", sa.Numeric(10, 3), nullable=True),
        sa.Column("average_watts", sa.Numeric(10, 3), nullable=True),
        sa.Column("elev_high", sa.Numeric(10, 3), nullable=True),
        sa.Column("elev_low", sa.Numeric(10, 3), nullable=True),
        sa.ForeignKeyConstraint(["record_id"], ["health_record_detail.record_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("record_id"),
    )

    op.create_table(
        "sleep_details",
        sa.Column("record_id", sa.UUID(), nullable=False),
        sa.Column("sleep_total_duration_minutes", sa.Numeric(10, 3), nullable=True),
        sa.Column("sleep_time_in_bed_minutes", sa.Numeric(10, 3), nullable=True),
        sa.Column("sleep_efficiency_score", sa.Numeric(10, 3), nullable=True),
        sa.Column("sleep_deep_minutes", sa.Numeric(10, 3), nullable=True),
        sa.Column("sleep_rem_minutes", sa.Numeric(10, 3), nullable=True),
        sa.Column("sleep_light_minutes", sa.Numeric(10, 3), nullable=True),
        sa.Column("sleep_awake_minutes", sa.Numeric(10, 3), nullable=True),
        sa.ForeignKeyConstraint(["record_id"], ["health_record_detail.record_id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("record_id"),
    )

    op.execute(
        """
        INSERT INTO health_record_detail (record_id, detail_type)
        SELECT id, 'workout'
        FROM health_record
        WHERE heart_rate_min IS NOT NULL
           OR heart_rate_max IS NOT NULL
           OR heart_rate_avg IS NOT NULL
           OR steps_min IS NOT NULL
           OR steps_max IS NOT NULL
           OR steps_avg IS NOT NULL;
        """
    )

    op.execute(
        """
        INSERT INTO workout_details (
            record_id,
            heart_rate_min,
            heart_rate_max,
            heart_rate_avg,
            steps_min,
            steps_max,
            steps_avg
        )
        SELECT
            hr.id,
            hr.heart_rate_min,
            hr.heart_rate_max,
            hr.heart_rate_avg,
            hr.steps_min,
            hr.steps_max,
            hr.steps_avg
        FROM health_record AS hr
        JOIN health_record_detail AS hrd ON hrd.record_id = hr.id AND hrd.detail_type = 'workout';
        """
    )

    for column in ["heart_rate_min", "heart_rate_max", "heart_rate_avg", "steps_min", "steps_max", "steps_avg"]:
        op.drop_column("health_record", column)


def downgrade() -> None:
    for column in [
        sa.Column("heart_rate_min", sa.Numeric(10, 3), nullable=True),
        sa.Column("heart_rate_max", sa.Numeric(10, 3), nullable=True),
        sa.Column("heart_rate_avg", sa.Numeric(10, 3), nullable=True),
        sa.Column("steps_min", sa.Numeric(10, 3), nullable=True),
        sa.Column("steps_max", sa.Numeric(10, 3), nullable=True),
        sa.Column("steps_avg", sa.Numeric(10, 3), nullable=True),
    ]:
        op.add_column("health_record", column)

    op.execute(
        """
        UPDATE health_record AS hr
        SET
            heart_rate_min = wd.heart_rate_min,
            heart_rate_max = wd.heart_rate_max,
            heart_rate_avg = wd.heart_rate_avg,
            steps_min = wd.steps_min,
            steps_max = wd.steps_max,
            steps_avg = wd.steps_avg
        FROM workout_details AS wd
        JOIN health_record_detail AS hrd ON hrd.record_id = wd.record_id AND hrd.detail_type = 'workout'
        WHERE hr.id = wd.record_id;
        """
    )

    op.drop_table("sleep_details")
    op.drop_table("workout_details")
    op.drop_table("health_record_detail")

