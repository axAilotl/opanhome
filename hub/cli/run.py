from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path

import typer

from hub.adapters.agent.hermes_streaming import HermesStreamingProvider
from hub.adapters.stt.deepgram_live import DeepgramLiveSTTProvider
from hub.adapters.tts.elevenlabs_streaming import ElevenLabsStreamingTTS
from hub.devices.esphome_session import ESPHomeSession
from hub.devices.voice_runtime_streaming import StreamingVoiceAssistantRuntime
from hub.media.http_audio import StaticAudioServer
from hub.runtime import load_runtime_config
from hub.storage.session_cache import SessionCache


async def _run_runtime(project_root: Path) -> None:
    config = load_runtime_config(project_root)
    audio_server = StaticAudioServer(
        host=config.audio_bind_host,
        port=config.audio_port,
        root=config.audio_root,
        public_host=config.audio_public_host,
    )
    audio_server.start()

    stt = DeepgramLiveSTTProvider(api_key=config.deepgram_api_key)
    tts = ElevenLabsStreamingTTS(
        api_key=config.elevenlabs_api_key,
        voice_id=config.elevenlabs_voice_id,
        model_id=config.elevenlabs_model_id,
    )
    agent = HermesStreamingProvider(
        gateway_home=config.hermes_gateway_home,
        model_name=config.hermes_model,
    )
    session_cache = SessionCache(ttl=timedelta(seconds=config.session_ttl_seconds))

    try:
        async with ESPHomeSession(config.esphome_target) as session:
            device_info = await session.device_info()
            runtime = StreamingVoiceAssistantRuntime(
                session=session,
                stt=stt,
                agent=agent,
                tts=tts,
                audio_server=audio_server,
                session_cache=session_cache,
                artifacts_root=config.artifacts_root,
                continue_conversation=config.continue_conversation,
                announcement_timeout_seconds=config.announcement_timeout_seconds,
                reply_timeout_seconds=config.reply_timeout_seconds,
                endpointing_grace_seconds=config.voice_endpointing_grace_seconds,
                silence_timeout_seconds=config.voice_silence_timeout_seconds,
                max_turn_seconds=config.voice_max_turn_seconds,
                speech_rms_threshold=config.voice_speech_rms_threshold,
            )
            unsubscribe = session.subscribe_voice_assistant(
                handle_start=runtime.handle_start,
                handle_stop=runtime.handle_stop,
                handle_audio=runtime.handle_audio,
            )
            try:
                typer.echo(
                    f"Connected to {device_info.friendly_name or device_info.name} at "
                    f"{config.esphome_target.host}:{config.esphome_target.port}"
                )
                typer.echo(f"Hermes backend: {config.hermes_agent_backend}")
                typer.echo(f"Hermes model: {config.hermes_model}")
                typer.echo(f"Audio server: http://{config.audio_public_host}:{config.audio_port}/")
                typer.echo("Voice bridge is running. Press Ctrl-C to stop.")
                while True:
                    await asyncio.sleep(3600)
            finally:
                unsubscribe()
    finally:
        audio_server.stop()
        await agent.aclose()
        await stt.aclose()
        await tts.aclose()


def run() -> None:
    """Run the end-to-end voice bridge for the configured ESPHome endpoint."""
    try:
        asyncio.run(_run_runtime(Path.cwd()))
    except KeyboardInterrupt:
        typer.echo("Stopped voice bridge")
