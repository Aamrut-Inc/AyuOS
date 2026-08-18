#!/usr/bin/env python3
"""Seed a local dev API key for the AyuOS app to use, if one doesn't exist yet.

The X-Open-Wearables-API-Key header is validated against a database-backed
key (see app/services/api_key_service.py), not a static secret, so there's
no env var to bake in. This makes a first-run local key available on disk
instead of requiring a manual authenticated POST /developer/api-keys call.
"""

from pathlib import Path

from app.database import SessionLocal
from app.services import api_key_service, developer_service

KEY_NAME = "ayuos-local"
OUTPUT_PATH = Path("/root_project/.local/dev-api-key")


def seed_dev_api_key() -> None:
    with SessionLocal() as db:
        existing = [k for k in api_key_service.list_api_keys(db) if k.name == KEY_NAME]
        if existing:
            print(f"API key '{KEY_NAME}' already exists, skipping seed.")
            OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
            OUTPUT_PATH.write_text(existing[0].id + "\n")
            return

        developers = developer_service.crud.get_all(db, filters={}, offset=0, limit=1, sort_by=None)
        created_by = developers[0].id if developers else None

        api_key = api_key_service.create_api_key(db, created_by, KEY_NAME)
        OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUTPUT_PATH.write_text(api_key.id + "\n")
        print(f"✓ Created local dev API key '{KEY_NAME}'.")


if __name__ == "__main__":
    seed_dev_api_key()
