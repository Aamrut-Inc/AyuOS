"""Token refresh must happen once even when several syncs need it at once.

Whoop (and other providers) rotate refresh tokens and revoke the grant when an
old one is replayed, so two concurrent refreshes with the same token kill the
user's connection. _get_valid_token locks the connection row and re-reads it
before refreshing.
"""

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from fastapi import HTTPException

from app.services.providers.api_client import _get_valid_token


def _connection(expires_in: timedelta) -> SimpleNamespace:
    return SimpleNamespace(
        access_token="old-access",
        refresh_token="refresh-1",
        token_expires_at=datetime.now(timezone.utc) + expires_in,
    )


def test_fresh_token_is_used_without_locking() -> None:
    db, oauth, repo = MagicMock(), MagicMock(), MagicMock()
    repo.get_by_user_and_provider.return_value = _connection(timedelta(hours=1))

    assert _get_valid_token(db, uuid4(), "whoop", repo, oauth) == "old-access"
    db.refresh.assert_not_called()
    oauth.refresh_access_token.assert_not_called()


def test_skips_refresh_when_another_sync_already_refreshed() -> None:
    db, oauth, repo = MagicMock(), MagicMock(), MagicMock()
    connection = _connection(timedelta(minutes=-1))
    repo.get_by_user_and_provider.return_value = connection

    def other_sync_refreshed(instance: SimpleNamespace, with_for_update: bool) -> None:
        assert with_for_update
        instance.access_token = "new-access"
        instance.refresh_token = "refresh-2"
        instance.token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    db.refresh.side_effect = other_sync_refreshed

    assert _get_valid_token(db, uuid4(), "whoop", repo, oauth) == "new-access"
    oauth.refresh_access_token.assert_not_called()
    db.commit.assert_called_once()  # releases the row lock


def test_refreshes_under_the_lock_when_still_expired() -> None:
    db, oauth, repo = MagicMock(), MagicMock(), MagicMock()
    repo.get_by_user_and_provider.return_value = _connection(timedelta(minutes=-1))
    oauth.refresh_access_token.return_value = SimpleNamespace(access_token="new-access")
    user_id = uuid4()

    assert _get_valid_token(db, user_id, "whoop", repo, oauth) == "new-access"
    db.refresh.assert_called_once()
    oauth.refresh_access_token.assert_called_once_with(db, user_id, "refresh-1")


def test_failed_refresh_releases_the_lock() -> None:
    db, oauth, repo = MagicMock(), MagicMock(), MagicMock()
    repo.get_by_user_and_provider.return_value = _connection(timedelta(minutes=-1))
    oauth.refresh_access_token.side_effect = HTTPException(status_code=400, detail="invalid_grant")

    with pytest.raises(HTTPException):
        _get_valid_token(db, uuid4(), "whoop", repo, oauth)
    db.rollback.assert_called_once()
