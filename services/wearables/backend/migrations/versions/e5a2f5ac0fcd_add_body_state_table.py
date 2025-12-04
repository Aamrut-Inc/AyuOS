"""introduce body_state table for slow-changing observations

Revision ID: e5a2f5ac0fcd
Revises: d2a7b13dbfea
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "e5a2f5ac0fcd"
down_revision: Union[str, None] = "d2a7b13dbfea"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "body_state",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("height_cm", sa.Numeric(10, 3), nullable=True),
        sa.Column("weight_kg", sa.Numeric(10, 3), nullable=True),
        sa.Column("body_fat_percentage", sa.Numeric(10, 3), nullable=True),
        sa.Column("resting_heart_rate", sa.Numeric(10, 3), nullable=True),
        sa.ForeignKeyConstraint(["user_id"], ["user.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )

    op.execute(
        """
        INSERT INTO body_state (id, user_id, height_cm, weight_kg, body_fat_percentage, resting_heart_rate)
        SELECT pr.id, pr.user_id, pr.height_cm, pr.weight_kg, pr.body_fat_percentage, pr.resting_heart_rate
        FROM personal_record pr
        WHERE pr.height_cm IS NOT NULL
           OR pr.weight_kg IS NOT NULL
           OR pr.body_fat_percentage IS NOT NULL
           OR pr.resting_heart_rate IS NOT NULL
        """,
    )

    op.drop_column("personal_record", "height_cm")
    op.drop_column("personal_record", "weight_kg")
    op.drop_column("personal_record", "body_fat_percentage")
    op.drop_column("personal_record", "resting_heart_rate")


def downgrade() -> None:
    op.add_column("personal_record", sa.Column("resting_heart_rate", sa.Numeric(10, 3), nullable=True))
    op.add_column("personal_record", sa.Column("body_fat_percentage", sa.Numeric(10, 3), nullable=True))
    op.add_column("personal_record", sa.Column("weight_kg", sa.Numeric(10, 3), nullable=True))
    op.add_column("personal_record", sa.Column("height_cm", sa.Numeric(10, 3), nullable=True))

    op.execute(
        """
        UPDATE personal_record pr
        SET
            height_cm = bs.height_cm,
            weight_kg = bs.weight_kg,
            body_fat_percentage = bs.body_fat_percentage,
            resting_heart_rate = bs.resting_heart_rate
        FROM (
            SELECT DISTINCT ON (user_id) *
            FROM body_state
            ORDER BY user_id, id DESC
        ) AS bs
        WHERE pr.user_id = bs.user_id
        """,
    )

    op.drop_table("body_state")

