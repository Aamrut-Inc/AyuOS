"""Tests for Whoop247Data cycle normalization and the max_heart_rate body-measurement fix.

Whoop's API has no continuous/raw heart rate endpoint (confirmed against
developer.whoop.com/api/) — average_heart_rate/max_heart_rate per cycle is
the highest-resolution heart rate data available beyond per-workout values.
"""

from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from sqlalchemy.orm import Session

from app.schemas.enums import SeriesType
from app.services.providers.whoop.data_247 import Whoop247Data
from app.services.providers.whoop.strategy import WhoopStrategy
from tests.factories import UserFactory


class TestWhoopCycleNormalization:
    """Tests for normalize_cycle."""

    @pytest.fixture
    def whoop_247(self) -> Whoop247Data:
        return WhoopStrategy().data_247

    @pytest.fixture
    def sample_cycle(self) -> dict[str, Any]:
        return {
            "id": 12345,
            "start": "2024-01-15T08:00:00.000Z",
            "end": "2024-01-16T08:00:00.000Z",
            "score_state": "SCORED",
            "score": {
                "strain": 12.3,
                "kilojoule": 8500.0,
                "average_heart_rate": 68,
                "max_heart_rate": 142,
            },
        }

    def test_normalize_cycle_extracts_heart_rate_fields(
        self, whoop_247: Whoop247Data, sample_cycle: dict[str, Any]
    ) -> None:
        user_id = uuid4()
        result = whoop_247.normalize_cycle(sample_cycle, user_id)

        assert result["user_id"] == user_id
        assert result["provider"] == "whoop"
        assert result["average_heart_rate"] == 68
        assert result["max_heart_rate"] == 142
        assert result["timestamp"] == datetime(2024, 1, 15, 8, 0, tzinfo=timezone.utc)

    def test_normalize_cycle_skips_unscored(self, whoop_247: Whoop247Data, sample_cycle: dict[str, Any]) -> None:
        sample_cycle["score_state"] = "PENDING_SCORE"
        result = whoop_247.normalize_cycle(sample_cycle, uuid4())
        assert result == {}

    def test_normalize_cycle_missing_start_returns_empty(
        self, whoop_247: Whoop247Data, sample_cycle: dict[str, Any]
    ) -> None:
        del sample_cycle["start"]
        result = whoop_247.normalize_cycle(sample_cycle, uuid4())
        assert result == {}

    def test_normalize_cycle_missing_score_fields(self, whoop_247: Whoop247Data, sample_cycle: dict[str, Any]) -> None:
        sample_cycle["score"] = {"strain": 12.3, "kilojoule": 8500.0}
        result = whoop_247.normalize_cycle(sample_cycle, uuid4())

        assert result["average_heart_rate"] is None
        assert result["max_heart_rate"] is None


class TestWhoopSaveCycleData:
    """Tests for save_cycle_data."""

    @pytest.fixture
    def whoop_247(self) -> Whoop247Data:
        return WhoopStrategy().data_247

    @patch("app.repositories.data_point_series_repository.DataPointSeriesRepository.bulk_create")
    def test_save_cycle_data_creates_two_samples(
        self, mock_bulk_create: MagicMock, whoop_247: Whoop247Data, db: Session
    ) -> None:
        user = UserFactory()
        normalized = {
            "user_id": user.id,
            "provider": "whoop",
            "timestamp": datetime(2024, 1, 15, 8, 0, tzinfo=timezone.utc),
            "average_heart_rate": 68,
            "max_heart_rate": 142,
        }

        count = whoop_247.save_cycle_data(db, user.id, normalized)

        mock_bulk_create.assert_called_once()
        saved_samples = mock_bulk_create.call_args[0][1]
        assert len(saved_samples) == 2
        assert count == 2

        series_types = {sample.series_type for sample in saved_samples}
        assert series_types == {SeriesType.average_heart_rate, SeriesType.max_heart_rate}

    def test_save_cycle_data_empty_normalized_returns_zero(self, whoop_247: Whoop247Data, db: Session) -> None:
        count = whoop_247.save_cycle_data(db, uuid4(), {})
        assert count == 0

    @patch("app.repositories.data_point_series_repository.DataPointSeriesRepository.bulk_create")
    def test_save_cycle_data_partial_fields(
        self, mock_bulk_create: MagicMock, whoop_247: Whoop247Data, db: Session
    ) -> None:
        user = UserFactory()
        normalized = {
            "user_id": user.id,
            "provider": "whoop",
            "timestamp": datetime(2024, 1, 15, 8, 0, tzinfo=timezone.utc),
            "average_heart_rate": 68,
            "max_heart_rate": None,
        }

        count = whoop_247.save_cycle_data(db, user.id, normalized)

        assert count == 1
        saved_samples = mock_bulk_create.call_args[0][1]
        assert saved_samples[0].series_type == SeriesType.average_heart_rate


class TestWhoopBodyMeasurementMaxHeartRate:
    """Tests for the previously-dropped max_heart_rate in body measurement save."""

    @pytest.fixture
    def whoop_247(self) -> Whoop247Data:
        return WhoopStrategy().data_247

    @patch("app.repositories.data_point_series_repository.DataPointSeriesRepository.bulk_create")
    @patch("app.services.providers.whoop.data_247.Whoop247Data.get_body_measurement")
    def test_max_heart_rate_is_saved(
        self,
        mock_get_body_measurement: MagicMock,
        mock_bulk_create: MagicMock,
        whoop_247: Whoop247Data,
        db: Session,
    ) -> None:
        user = UserFactory()
        mock_get_body_measurement.return_value = {
            "height_meter": 1.8,
            "weight_kilogram": 75.0,
            "max_heart_rate": 190,
        }

        count = whoop_247.load_and_save_body_measurement(db, user.id)

        # height + weight + max_heart_rate = 3 samples on first sync (no prior values)
        assert count == 3
        saved_samples = mock_bulk_create.call_args[0][1]
        series_types = {sample.series_type for sample in saved_samples}
        assert SeriesType.max_heart_rate in series_types

        max_hr_sample = next(s for s in saved_samples if s.series_type == SeriesType.max_heart_rate)
        assert max_hr_sample.value == Decimal("190")
