from fastapi import HTTPException

# Provider responses that mean "this data type isn't available for this
# account" (no membership, scope not granted, endpoint not offered). Retrying
# won't help, so they mustn't hold the sync cursor back forever.
PERMANENT_STATUS_CODES = frozenset({403, 404})


def is_permanent_sync_error(error: Exception) -> bool:
    """True if a failed fetch will fail the same way next time.

    Everything else — network errors, 5xx, 429, expired/revoked tokens — is
    transient: the window must be fetched again, so the caller must not
    advance last_synced_at past it.
    """
    return isinstance(error, HTTPException) and error.status_code in PERMANENT_STATUS_CODES
