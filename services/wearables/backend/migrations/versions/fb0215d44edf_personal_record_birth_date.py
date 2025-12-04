"""replace age_years with birth_date on personal_record

Revision ID: fb0215d44edf
Revises: e5a2f5ac0fcd
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "fb0215d44edf"
down_revision: Union[str, None] = "e5a2f5ac0fcd"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("personal_record", sa.Column("birth_date", sa.Date(), nullable=True))
    op.drop_column("personal_record", "age_years")


def downgrade() -> None:
    op.add_column("personal_record", sa.Column("age_years", sa.Integer(), nullable=True))
    op.drop_column("personal_record", "birth_date")

