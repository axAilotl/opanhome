from __future__ import annotations

import array

import pytest

from hub.devices.voice_runtime import VoiceAssistantRuntime
from hub.devices.voice_runtime_streaming import StreamingVoiceAssistantRuntime


@pytest.mark.parametrize("runtime_cls", [VoiceAssistantRuntime, StreamingVoiceAssistantRuntime])
def test_chunk_rms_returns_zero_for_empty_audio(runtime_cls: type) -> None:
    assert runtime_cls._chunk_rms(b"") == 0.0
    assert runtime_cls._chunk_rms(b"\x01") == 0.0


@pytest.mark.parametrize("runtime_cls", [VoiceAssistantRuntime, StreamingVoiceAssistantRuntime])
def test_chunk_rms_detects_signal_level(runtime_cls: type) -> None:
    samples = array.array("h", [0, 0, 120, -120, 300, -300])
    rms = runtime_cls._chunk_rms(samples.tobytes())

    assert 180.0 < rms < 190.0
