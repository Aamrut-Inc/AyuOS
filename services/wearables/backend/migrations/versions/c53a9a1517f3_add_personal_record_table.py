"""add personal_record table

Revision ID: c53a9a1517f3
Revises: b5d3f2f0d6c1
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "c53a9a1517f3"
down_revision: Union[str, None] = "b5d3f2f0d6c1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "personal_record",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("age_years", sa.Integer(), nullable=True),
        sa.Column("height_cm", sa.Numeric(10, 3), nullable=True),
        sa.Column("weight_kg", sa.Numeric(10, 3), nullable=True),
        sa.Column("gender", sa.String(length=64), nullable=True),
        sa.Column("body_fat_percentage", sa.Numeric(10, 3), nullable=True),
        sa.Column("resting_heart_rate", sa.Numeric(10, 3), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", name="uq_personal_record_user_id"),
    )


def downgrade() -> None:
    op.drop_table("personal_record")

