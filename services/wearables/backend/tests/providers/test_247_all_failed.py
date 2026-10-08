"""load_and_save_all must raise when part of the window wasn't fetched.

Each data type's errors are swallowed individually, so before this check an
offline or expired-token sync reported success and sync_vendor_data advanced
last_synced_at past a window that was never fetched — permanently skipping it.
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.services.providers.oura.strategy import OuraStrategy
from app.services.providers.whoop.strategy import WhoopStrategy

END = datetime.now(timezone.utc)
START = END - timedelta(days=1)
OFFLINE = OSError("[Errno -2] Name or service not known")


def test_oura_raises_when_every_type_fails() -> None:
    data_247 = OuraStrategy().data_247
    getters = [name for name in dir(data_247) if name.startswith("get_") and name.endswith(("_data", "_samples"))]
    with (
        patch.multiple(data_247, **{name: MagicMock(side_effect=OFFLINE) for name in getters}),
        patch.object(data_247, "get_personal_info", side_effect=OFFLINE),
        pytest.raises(RuntimeError, match="Oura data types failed"),
    ):
        data_247.load_and_save_all(MagicMock(), uuid4(), start_time=START, end_time=END)


def test_whoop_raises_when_core_streams_fail() -> None:
    data_247 = WhoopStrategy().data_247
    with (
        patch.object(data_247, "load_and_save_sleep", side_effect=OFFLINE),
        patch.object(data_247, "load_and_save_recovery", side_effect=OFFLINE),
        patch.object(data_247, "load_and_save_cycle", side_effect=OFFLINE),
        patch.object(data_247, "load_and_save_body_measurement", return_value=0),
        pytest.raises(RuntimeError, match="Whoop data types failed"),
    ):
        data_247.load_and_save_all(MagicMock(), uuid4(), start_time=START, end_time=END)


def test_whoop_transient_partial_failure_raises() -> None:
    data_247 = WhoopStrategy().data_247
    with (
        patch.object(data_247, "load_and_save_sleep", return_value=3),
        patch.object(data_247, "load_and_save_recovery", side_effect=OFFLINE),
        patch.object(data_247, "load_and_save_cycle", return_value=2),
        patch.object(data_247, "load_and_save_body_measurement", return_value=0),
        pytest.raises(RuntimeError, match=r"\(recovery\)"),
    ):
        data_247.load_and_save_all(MagicMock(), uuid4(), start_time=START, end_time=END)


def test_whoop_permanent_failure_does_not_block_cursor() -> None:
    data_247 = WhoopStrategy().data_247
    not_entitled = HTTPException(status_code=403, detail="not available for this membership")
    with (
        patch.object(data_247, "load_and_save_sleep", return_value=3),
        patch.object(data_247, "load_and_save_recovery", side_effect=not_entitled),
        patch.object(data_247, "load_and_save_cycle", return_value=2),
        patch.object(data_247, "load_and_save_body_measurement", return_value=0),
    ):
        results = data_247.load_and_save_all(MagicMock(), uuid4(), start_time=START, end_time=END)
    assert results["sleep_sessions_synced"] == 3
