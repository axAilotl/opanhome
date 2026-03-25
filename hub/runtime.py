from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import socket

from dotenv import load_dotenv

from hub.config import ESPHomeTarget, RealtimeTarget


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _resolve_path(project_root: Path, value: str) -> Path:
    path = Path(value).expanduser()
    if path.is_absolute():
        return path
    return project_root / path


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ValueError(f"Missing required setting: {name}")
    return value


def _load_optional_env(path: Path, *, override: bool) -> None:
    if path.exists():
        load_dotenv(path, override=override, encoding="utf-8")


def detect_outbound_host(remote_host: str, remote_port: int) -> str:
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
        sock.connect((remote_host, remote_port))
        return sock.getsockname()[0]


@dataclass(slots=True)
class HubRuntimeConfig:
    project_root: Path
    device_transport: str
    esphome_target: ESPHomeTarget | None
    realtime_target: RealtimeTarget
    deepgram_api_key: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str | None
    elevenlabs_model_id: str
    psfn_api_base_url: str
    psfn_api_key: str | None
    psfn_model: str
    psfn_author_id: str | None
    psfn_author_name: str | None
    audio_bind_host: str
    audio_public_host: str
    audio_port: int
    artifacts_root: Path
    continue_conversation: bool
    session_ttl_seconds: int
    announcement_timeout_seconds: float
    reply_timeout_seconds: float
    voice_initial_silence_timeout_seconds: float
    voice_endpointing_grace_seconds: float
    voice_silence_timeout_seconds: float
    voice_max_turn_seconds: float
    voice_speech_rms_threshold: float
    voice_min_speech_chunks_for_endpointing: int

    @property
    def audio_root(self) -> Path:
        return self.artifacts_root / "audio"


def load_runtime_config(project_root: Path) -> HubRuntimeConfig:
    project_env = project_root / ".env"
    _load_optional_env(project_env, override=True)

    device_transport = os.getenv("DEVICE_TRANSPORT", "esphome").strip().lower()
    if device_transport not in {"esphome", "realtime", "hybrid"}:
        raise ValueError(f"Unsupported DEVICE_TRANSPORT: {device_transport}")

    esphome_target: ESPHomeTarget | None = None
    detect_host: str | None = None
    detect_port: int | None = None
    if device_transport in {"esphome", "hybrid"}:
        host = _required("ESPHOME_HOST")
        port = int(os.getenv("ESPHOME_PORT", "6053"))
        noise_psk = os.getenv("ESPHOME_NOISE_PSK") or None
        password = os.getenv("ESPHOME_PASSWORD") or None
        expected_name = os.getenv("ESPHOME_EXPECTED_NAME") or None
        esphome_target = ESPHomeTarget(
            host=host,
            port=port,
            password=password,
            noise_psk=noise_psk,
            expected_name=expected_name,
        )
        detect_host = host
        detect_port = port

    audio_bind_host = os.getenv("AUDIO_SERVER_BIND_HOST", "0.0.0.0")
    configured_audio_public_host = os.getenv("AUDIO_PUBLIC_HOST") or None
    audio_port = int(os.getenv("AUDIO_SERVER_PORT", "8099"))
    realtime_bind_host = os.getenv("REALTIME_VOICE_BIND_HOST", "0.0.0.0")
    realtime_port = int(os.getenv("REALTIME_VOICE_PORT", "8787"))
    configured_realtime_public_host = os.getenv("REALTIME_VOICE_PUBLIC_HOST") or None
    if configured_audio_public_host:
        audio_public_host = configured_audio_public_host
    elif device_transport == "realtime":
        if not configured_realtime_public_host:
            raise ValueError(
                "AUDIO_PUBLIC_HOST or REALTIME_VOICE_PUBLIC_HOST is required when DEVICE_TRANSPORT=realtime",
            )
        audio_public_host = configured_realtime_public_host
    else:
        assert detect_host is not None and detect_port is not None
        audio_public_host = detect_outbound_host(detect_host, detect_port)
    realtime_public_host = configured_realtime_public_host or audio_public_host

    psfn_api_base_url = os.getenv("PSFN_API_BASE_URL", "http://127.0.0.1:3100/v1").strip()
    psfn_api_key = os.getenv("PSFN_API_KEY") or None
    psfn_model = os.getenv("PSFN_MODEL", "psfn").strip()
    psfn_author_id = os.getenv("PSFN_AUTHOR_ID") or None
    psfn_author_name = os.getenv("PSFN_AUTHOR_NAME") or None
    if bool(psfn_author_id) != bool(psfn_author_name):
        raise ValueError("PSFN_AUTHOR_ID and PSFN_AUTHOR_NAME must both be set when either is configured")
    artifacts_root = _resolve_path(project_root, os.getenv("ARTIFACT_ROOT", ".artifacts/runtime"))

    return HubRuntimeConfig(
        project_root=project_root,
        device_transport=device_transport,
        esphome_target=esphome_target,
        realtime_target=RealtimeTarget(
            bind_host=realtime_bind_host,
            port=realtime_port,
            public_host=realtime_public_host,
        ),
        deepgram_api_key=_required("DEEPGRAM_API_KEY"),
        elevenlabs_api_key=_required("ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=os.getenv("ELEVENLABS_VOICE_ID") or None,
        elevenlabs_model_id=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
        psfn_api_base_url=psfn_api_base_url,
        psfn_api_key=psfn_api_key,
        psfn_model=psfn_model,
        psfn_author_id=psfn_author_id,
        psfn_author_name=psfn_author_name,
        audio_bind_host=audio_bind_host,
        audio_public_host=audio_public_host,
        audio_port=audio_port,
        artifacts_root=artifacts_root,
        continue_conversation=_env_bool("CONTINUE_CONVERSATION", True),
        session_ttl_seconds=int(os.getenv("SESSION_TTL_SECONDS", "300")),
        announcement_timeout_seconds=float(os.getenv("ANNOUNCEMENT_TIMEOUT_SECONDS", "120")),
        reply_timeout_seconds=float(os.getenv("VOICE_REPLY_TIMEOUT_SECONDS", "30")),
        voice_initial_silence_timeout_seconds=float(os.getenv("VOICE_INITIAL_SILENCE_TIMEOUT_SECONDS", "4.0")),
        voice_endpointing_grace_seconds=float(os.getenv("VOICE_ENDPOINTING_GRACE_SECONDS", "2.0")),
        voice_silence_timeout_seconds=float(os.getenv("VOICE_SILENCE_TIMEOUT_SECONDS", "1.2")),
        voice_max_turn_seconds=float(os.getenv("VOICE_MAX_TURN_SECONDS", "20")),
        voice_speech_rms_threshold=float(os.getenv("VOICE_SPEECH_RMS_THRESHOLD", "25")),
        voice_min_speech_chunks_for_endpointing=int(os.getenv("VOICE_MIN_SPEECH_CHUNKS_FOR_ENDPOINTING", "4")),
    )
