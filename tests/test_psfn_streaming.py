from __future__ import annotations

import json

import httpx
import pytest

from hub.adapters.agent.psfn_streaming import PsfnStreamingProvider


@pytest.mark.anyio
async def test_psfn_streaming_provider_streams_deltas_and_persists_history() -> None:
    requests: list[dict[str, object]] = []
    request_headers: list[dict[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        requests.append(body)
        request_headers.append({
            "x-psfn-channel-type": request.headers.get("x-psfn-channel-type", ""),
            "x-psfn-channel-id": request.headers.get("x-psfn-channel-id", ""),
            "x-psfn-author-id": request.headers.get("x-psfn-author-id", ""),
            "x-psfn-author-name": request.headers.get("x-psfn-author-name", ""),
        })
        if len(requests) == 1:
            stream = (
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"psfn","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n'
                'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"psfn","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
                "data: [DONE]\n\n"
            )
            return httpx.Response(
                200,
                content=stream.encode("utf-8"),
                headers={"Content-Type": "text/event-stream"},
                request=request,
            )
        stream = (
            'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":1,"model":"psfn","choices":[{"index":0,"delta":{"content":"Again"},"finish_reason":null}]}\n\n'
            "data: [DONE]\n\n"
        )
        return httpx.Response(
            200,
            content=stream.encode("utf-8"),
            headers={"Content-Type": "text/event-stream"},
            request=request,
        )

    client = httpx.AsyncClient(
        base_url="http://psfn.test/v1",
        transport=httpx.MockTransport(handler),
    )
    provider = PsfnStreamingProvider(
        api_base_url="http://psfn.test/v1",
        api_key=None,
        model_name="psfn",
        client=client,
    )

    first_chunks = [chunk async for chunk in provider.stream_reply(text="hello", conversation_id="realtime:pi-w")]
    second_chunks = [chunk async for chunk in provider.stream_reply(text="follow up", conversation_id="realtime:pi-w")]

    assert first_chunks == ["Hello"]
    assert second_chunks == ["Again"]
    assert requests[0]["model"] == "psfn"
    assert requests[0]["stream"] is True
    assert requests[0]["system_prompt_mode"] == "custom"
    assert requests[0]["response_style"] == "concise"
    assert requests[0]["user"] == "realtime:pi-w"
    assert requests[0]["messages"] == [{"role": "user", "content": "hello"}]
    assert request_headers[0] == {
        "x-psfn-channel-type": "openhome",
        "x-psfn-channel-id": "openhome:realtime:pi-w",
        "x-psfn-author-id": "",
        "x-psfn-author-name": "",
    }
    assert requests[1]["messages"] == [
        {"role": "user", "content": "hello"},
        {"role": "assistant", "content": "Hello"},
        {"role": "user", "content": "follow up"},
    ]

    await provider.aclose()
    await client.aclose()
