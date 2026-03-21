from __future__ import annotations

from pathlib import Path

from hub.adapters.tts.elevenlabs_streaming import _should_flush
from hub.media.http_audio import StaticAudioServer
from hub.runtime import load_runtime_config


def test_load_runtime_config_reads_global_hermes_and_project_env(tmp_path: Path, monkeypatch) -> None:
    for name in (
        "ESPHOME_HOST",
        "ESPHOME_PORT",
        "ESPHOME_EXPECTED_NAME",
        "DEEPGRAM_API_KEY",
        "ELEVENLABS_API_KEY",
        "AUDIO_PUBLIC_HOST",
        "HERMES_AGENT_BACKEND",
        "HERMES_GATEWAY_HOME",
        "HERMES_HOME",
    ):
        monkeypatch.delenv(name, raising=False)

    hermes_home = tmp_path / "global-hermes"
    hermes_home.mkdir()
    (hermes_home / ".env").write_text(
        "DEEPGRAM_API_KEY=global-deepgram\n"
        "ELEVENLABS_API_KEY=global-eleven\n",
        encoding="utf-8",
    )
    (tmp_path / ".env").write_text(
        "ESPHOME_HOST=192.168.1.173\n"
        "ESPHOME_PORT=6053\n"
        "ESPHOME_EXPECTED_NAME=Opanhome-Voice-Pi\n"
        "AUDIO_PUBLIC_HOST=192.168.1.50\n"
        "HERMES_AGENT_BACKEND=gateway\n"
        f"HERMES_HOME={hermes_home}\n",
        encoding="utf-8",
    )

    config = load_runtime_config(tmp_path)

    assert config.esphome_target.host == "192.168.1.173"
    assert config.esphome_target.expected_name == "Opanhome-Voice-Pi"
    assert config.deepgram_api_key == "global-deepgram"
    assert config.elevenlabs_api_key == "global-eleven"
    assert config.audio_public_host == "192.168.1.50"
    assert config.hermes_agent_backend == "gateway"
    assert config.hermes_gateway_home == hermes_home
    assert config.hermes_home == hermes_home
    assert config.elevenlabs_model_id == "eleven_flash_v2_5"
    assert config.reply_timeout_seconds == 30.0
    assert config.voice_endpointing_grace_seconds == 2.0


def test_static_audio_server_uses_public_host_for_urls(tmp_path: Path) -> None:
    root = tmp_path / "audio"
    root.mkdir()
    audio_path = root / "reply.mp3"
    audio_path.write_bytes(b"test")

    server = StaticAudioServer(
        host="0.0.0.0",
        port=8099,
        root=root,
        public_host="192.168.1.50",
    )

    assert server.url_for(audio_path) == "http://192.168.1.50:8099/reply.mp3"


def test_static_audio_server_open_stream_uses_stream_endpoint(tmp_path: Path) -> None:
    root = tmp_path / "audio"
    root.mkdir()

    server = StaticAudioServer(
        host="0.0.0.0",
        port=8099,
        root=root,
        public_host="192.168.1.50",
    )

    stream = server.open_stream(content_type="audio/mpeg")

    assert stream.url.startswith("http://192.168.1.50:8099/streams/")
    stream.write(b"test")
    stream.close()


def test_should_flush_prefers_sentence_boundaries_but_allows_long_chunks() -> None:
    assert _should_flush("Hello there.") is True
    assert _should_flush("Short chunk") is False
    assert _should_flush(f"{'x' * 80} ") is True
