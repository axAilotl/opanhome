from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
import socket

from dotenv import dotenv_values, load_dotenv

from hub.config import ESPHomeTarget


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
    esphome_target: ESPHomeTarget
    deepgram_api_key: str
    elevenlabs_api_key: str
    elevenlabs_voice_id: str | None
    elevenlabs_model_id: str
    hermes_agent_backend: str
    hermes_home: Path
    hermes_gateway_home: Path
    hermes_model: str
    audio_bind_host: str
    audio_public_host: str
    audio_port: int
    artifacts_root: Path
    continue_conversation: bool
    session_ttl_seconds: int
    announcement_timeout_seconds: float
    reply_timeout_seconds: float
    voice_endpointing_grace_seconds: float
    voice_silence_timeout_seconds: float
    voice_max_turn_seconds: float
    voice_speech_rms_threshold: float

    @property
    def audio_root(self) -> Path:
        return self.artifacts_root / "audio"


def load_runtime_config(project_root: Path) -> HubRuntimeConfig:
    project_env = project_root / ".env"
    project_values = dotenv_values(project_env) if project_env.exists() else {}
    hermes_home_hint = str(project_values.get("HERMES_HOME") or os.getenv("HERMES_HOME") or Path.home() / ".hermes")
    default_hermes_home = _resolve_path(project_root, hermes_home_hint)
    gateway_home_hint = str(
        project_values.get("HERMES_GATEWAY_HOME") or os.getenv("HERMES_GATEWAY_HOME") or default_hermes_home
    )
    default_gateway_home = _resolve_path(
        project_root,
        gateway_home_hint,
    )

    seen_envs: set[Path] = set()
    for env_path in (default_gateway_home / ".env", default_hermes_home / ".env"):
        resolved = env_path.expanduser().resolve()
        if resolved in seen_envs:
            continue
        seen_envs.add(resolved)
        _load_optional_env(env_path, override=False)

    _load_optional_env(project_env, override=True)

    host = _required("ESPHOME_HOST")
    port = int(os.getenv("ESPHOME_PORT", "6053"))
    noise_psk = os.getenv("ESPHOME_NOISE_PSK") or None
    password = os.getenv("ESPHOME_PASSWORD") or None
    expected_name = os.getenv("ESPHOME_EXPECTED_NAME") or None

    audio_bind_host = os.getenv("AUDIO_SERVER_BIND_HOST", "0.0.0.0")
    audio_public_host = os.getenv("AUDIO_PUBLIC_HOST") or detect_outbound_host(host, port)
    audio_port = int(os.getenv("AUDIO_SERVER_PORT", "8099"))

    hermes_agent_backend = os.getenv("HERMES_AGENT_BACKEND", "subprocess").strip().lower()
    hermes_home = _resolve_path(project_root, os.getenv("HERMES_HOME", str(Path.home() / ".hermes")))
    hermes_gateway_home = _resolve_path(
        project_root,
        os.getenv("HERMES_GATEWAY_HOME", str(hermes_home)),
    )
    hermes_model = os.getenv("HERMES_MODEL", "moonshotai/kimi-k2.5")
    artifacts_root = _resolve_path(project_root, os.getenv("ARTIFACT_ROOT", ".artifacts/runtime"))

    return HubRuntimeConfig(
        project_root=project_root,
        esphome_target=ESPHomeTarget(
            host=host,
            port=port,
            password=password,
            noise_psk=noise_psk,
            expected_name=expected_name,
        ),
        deepgram_api_key=_required("DEEPGRAM_API_KEY"),
        elevenlabs_api_key=_required("ELEVENLABS_API_KEY"),
        elevenlabs_voice_id=os.getenv("ELEVENLABS_VOICE_ID") or None,
        elevenlabs_model_id=os.getenv("ELEVENLABS_MODEL_ID", "eleven_flash_v2_5"),
        hermes_agent_backend=hermes_agent_backend,
        hermes_home=hermes_home,
        hermes_gateway_home=hermes_gateway_home,
        hermes_model=hermes_model,
        audio_bind_host=audio_bind_host,
        audio_public_host=audio_public_host,
        audio_port=audio_port,
        artifacts_root=artifacts_root,
        continue_conversation=_env_bool("CONTINUE_CONVERSATION", False),
        session_ttl_seconds=int(os.getenv("SESSION_TTL_SECONDS", "300")),
        announcement_timeout_seconds=float(os.getenv("ANNOUNCEMENT_TIMEOUT_SECONDS", "120")),
        reply_timeout_seconds=float(os.getenv("VOICE_REPLY_TIMEOUT_SECONDS", "30")),
        voice_endpointing_grace_seconds=float(os.getenv("VOICE_ENDPOINTING_GRACE_SECONDS", "2.0")),
        voice_silence_timeout_seconds=float(os.getenv("VOICE_SILENCE_TIMEOUT_SECONDS", "1.2")),
        voice_max_turn_seconds=float(os.getenv("VOICE_MAX_TURN_SECONDS", "20")),
        voice_speech_rms_threshold=float(os.getenv("VOICE_SPEECH_RMS_THRESHOLD", "25")),
    )
