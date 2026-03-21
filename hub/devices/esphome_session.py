from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from aioesphomeapi import APIClient
from aioesphomeapi.model import EntityInfo, EntityState, UserService

from hub.config import ESPHomeTarget


@dataclass(slots=True)
class ProbeSnapshot:
    device_info: Any
    entities: list[EntityInfo]
    services: list[UserService]
    state_updates: list[dict[str, Any]]


class ESPHomeSession:
    def __init__(self, target: ESPHomeTarget) -> None:
        self._target = target
        self._client: APIClient | None = None

    async def __aenter__(self) -> "ESPHomeSession":
        self._client = APIClient(
            self._target.host,
            self._target.port,
            self._target.password,
            client_info=self._target.client_info,
            noise_psk=self._target.noise_psk,
            expected_name=self._target.expected_name,
            timezone=self._target.timezone,
        )
        await self._client.connect(login=True)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._client is not None:
            await self._client.disconnect(force=True)
            self._client = None

    @property
    def client(self) -> APIClient:
        if self._client is None:
            raise RuntimeError("ESPHome session is not connected")
        return self._client

    async def device_info(self) -> Any:
        return await self.client.device_info()

    async def list_entities_services(self) -> tuple[list[EntityInfo], list[UserService]]:
        return await self.client.list_entities_services()

    def subscribe_states(self, on_state: Callable[[EntityState], None]) -> None:
        self.client.subscribe_states(on_state)

    def subscribe_voice_assistant(self, **kwargs: Any):
        return self.client.subscribe_voice_assistant(**kwargs)
