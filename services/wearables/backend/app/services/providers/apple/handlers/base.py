from abc import ABC, abstractmethod
from typing import Any

from app.schemas.health_record import HealthRecordCreate


class AppleSourceHandler(ABC):
    """Base interface for Apple Health data source handlers."""

    @abstractmethod
    def normalize(self, data: Any) -> list[HealthRecordCreate]:
        """Normalizes raw data from a specific Apple source into unified health records.

        Args:
            data: The raw data payload.

        Returns:
            list[HealthRecordCreate]: A list of normalized workout objects.
        """
        pass
