from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import subprocess

from hub.adapters.interfaces import AgentProvider, AgentReply


class HermesAgentProvider(AgentProvider):
    def __init__(
        self,
        *,
        hermes_home: Path,
        model_name: str,
        max_iterations: int = 10,
        backend: str = "subprocess",
        gateway_home: Path | None = None,
    ) -> None:
        self._hermes_home = hermes_home
        self._model_name = model_name
        self._max_iterations = max_iterations
        self._backend = backend.strip().lower()
        if self._backend not in {"subprocess", "gateway"}:
            raise ValueError(f"Unsupported Hermes backend: {backend}")
        self._gateway_home = gateway_home or Path.home() / ".hermes"
        self._hermes_repo = Path.home() / ".hermes" / "hermes-agent"
        self._python = self._hermes_repo / "venv" / "bin" / "python"

    async def reply(
        self,
        *,
        text: str,
        conversation_id: str,
        history: list[dict[str, str]],
    ) -> AgentReply:
        def _run_subprocess() -> AgentReply:
            payload = {
                "text": text,
                "history": history,
                "model_name": self._model_name,
                "max_iterations": self._max_iterations,
                "conversation_id": conversation_id,
            }
            result = subprocess.run(
                [str(self._python), "-c", _HERMES_SUBPROCESS],
                cwd=self._hermes_repo,
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                check=False,
                env={
                    **dict(os.environ),
                    "HERMES_HOME": str(self._hermes_home),
                },
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or "Hermes subprocess failed")
            marker = "__HERMES_JSON__"
            for line in reversed(result.stdout.splitlines()):
                if line.startswith(marker):
                    response = json.loads(line[len(marker):])
                    break
            else:
                raise RuntimeError("Hermes subprocess did not return a JSON payload")
            return AgentReply(
                text=response["text"],
                history=response["history"],
            )

        def _run_gateway() -> AgentReply:
            payload = {
                "text": text,
                "history": history,
                "model_name": self._model_name,
                "max_iterations": self._max_iterations,
                "conversation_id": conversation_id,
                "gateway_home": str(self._gateway_home),
                "chat_id": f"esphome-voice:{conversation_id.replace('/', '_')}",
                "chat_name": f"ESPHome Voice {conversation_id}",
            }
            result = subprocess.run(
                [str(self._python), "-c", _GATEWAY_SUBPROCESS],
                cwd=self._hermes_repo,
                input=json.dumps(payload),
                text=True,
                capture_output=True,
                check=False,
                env=dict(os.environ),
            )
            if result.returncode != 0:
                raise RuntimeError(result.stderr.strip() or "Hermes gateway subprocess failed")
            marker = "__HERMES_JSON__"
            for line in reversed(result.stdout.splitlines()):
                if line.startswith(marker):
                    response = json.loads(line[len(marker):])
                    break
            else:
                raise RuntimeError("Hermes gateway subprocess did not return a JSON payload")
            return AgentReply(
                text=response["text"],
                history=response["history"],
            )

        runner = _run_gateway if self._backend == "gateway" else _run_subprocess
        return await asyncio.to_thread(runner)


_HERMES_SUBPROCESS = """
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

payload = json.load(sys.stdin)
hermes_home = Path(os.environ["HERMES_HOME"])
load_dotenv(hermes_home / ".env", override=True, encoding="utf-8")

import run_agent

agent = run_agent.AIAgent(
    model=payload["model_name"],
    quiet_mode=True,
    skip_context_files=True,
    skip_memory=True,
    max_iterations=payload["max_iterations"],
    enabled_toolsets=["__none__"],
)
result = agent.run_conversation(
    user_message=payload["text"],
    conversation_history=payload["history"],
    task_id=payload["conversation_id"],
)
print(
    "__HERMES_JSON__"
    + json.dumps(
        {
            "text": result["final_response"],
            "history": result["messages"],
        }
    )
)
"""


_GATEWAY_SUBPROCESS = """
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

payload = json.load(sys.stdin)
gateway_home = Path(payload["gateway_home"]).expanduser()
os.environ["HERMES_HOME"] = str(gateway_home)
os.environ["HERMES_MODEL"] = payload["model_name"]
os.environ["HERMES_MAX_ITERATIONS"] = str(payload["max_iterations"])

from dotenv import load_dotenv

load_dotenv(gateway_home / ".env", override=True, encoding="utf-8")

from gateway.config import Platform
from gateway.run import GatewayRunner
from gateway.session import SessionSource, build_session_context, build_session_context_prompt


async def main() -> None:
    runner = GatewayRunner()
    source = SessionSource(
        platform=Platform.LOCAL,
        chat_id=payload["chat_id"],
        chat_name=payload["chat_name"],
        chat_type="channel",
        user_id="voice-hub",
        user_name="Voice Hub",
    )
    session_entry = runner.session_store.get_or_create_session(source)
    context = build_session_context(source, runner.config, session_entry)
    context_prompt = build_session_context_prompt(context)
    history = runner.session_store.load_transcript(session_entry.session_id)
    if not history:
        history = payload["history"]

    agent_result = await runner._run_agent(
        message=payload["text"],
        context_prompt=context_prompt,
        history=history,
        source=source,
        session_id=session_entry.session_id,
        session_key=session_entry.session_key,
    )

    response = agent_result.get("final_response", "")
    agent_messages = agent_result.get("messages", [])
    ts = datetime.now().isoformat()

    if not history:
        tool_defs = agent_result.get("tools", [])
        runner.session_store.append_to_transcript(
            session_entry.session_id,
            {
                "role": "session_meta",
                "tools": tool_defs or [],
                "model": payload["model_name"],
                "platform": source.platform.value,
                "timestamp": ts,
            },
        )

    history_len = agent_result.get("history_offset", len(history))
    new_messages = agent_messages[history_len:] if len(agent_messages) > history_len else []

    if not new_messages:
        runner.session_store.append_to_transcript(
            session_entry.session_id,
            {"role": "user", "content": payload["text"], "timestamp": ts},
        )
        if response:
            runner.session_store.append_to_transcript(
                session_entry.session_id,
                {"role": "assistant", "content": response, "timestamp": ts},
            )
    else:
        for message in new_messages:
            if message.get("role") == "system":
                continue
            entry = {**message, "timestamp": ts}
            runner.session_store.append_to_transcript(session_entry.session_id, entry)

    runner.session_store.update_session(session_entry.session_key)

    print(
        "__HERMES_JSON__"
        + json.dumps(
            {
                "text": response,
                "history": agent_messages,
            }
        )
    )


asyncio.run(main())
"""
