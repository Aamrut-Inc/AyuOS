from abc import ABC, abstractmethod
from typing import Any

from app.schemas.event_record import EventRecordCreate


class AppleSourceHandler(ABC):
    """Base interface for Apple Health data source handlers."""

    @abstractmethod
    def normalize(self, data: Any) -> list[EventRecordCreate]:
        """Normalizes raw data from a specific Apple source into unified event records.

        Args:
            data: The raw data payload.

        Returns:
            list[EventRecordCreate]: A list of normalized workout objects.
        """
        pass
