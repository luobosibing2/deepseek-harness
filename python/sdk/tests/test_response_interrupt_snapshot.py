"""Keep an owned Python SDK run open across a recorded response interruption."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from deepseek_harness import DeepSeekHarness


ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / "apps" / "cli" / "lib" / "bin.js"
SCENARIO = ROOT / "snapshots" / "sdk" / "response-interrupt"


@pytest.mark.skipif(not CLI.exists(), reason="requires the built dsh profile runtime")
def test_response_interruption_continues_one_owned_run(tmp_path: Path) -> None:
    provider = "snapshot-response-interrupt"
    patch = tmp_path / "response-interrupt.patch.yml"
    patch.write_text(json.dumps([
        {"id": "llm-deepseek", "disabled": True},
        {"id": "session-title-llm", "disabled": True},
        {"id": "session-log-deepseek", "config": {"enabled": False}},
        {"insert": [
            {
                "id": "llm-replay",
                "name": (ROOT / "packages" / "test-support" / "llm-replay" / "lib" / "index.js").as_uri(),
                "config": {"providers": [{"id": provider, "name": "Snapshot", "models": [{"id": "snapshot"}]}]},
            },
            {"id": "response-interrupt-fixture", "name": (SCENARIO / "interrupt.mjs").as_uri()},
        ]},
    ]))
    with DeepSeekHarness(
        dsh_bin=str(CLI),
        dsh_home=str(tmp_path / "home"),
        cwd=str(tmp_path),
        profile="sdk",
        patches=(str(patch),),
        provider=provider,
        model="snapshot",
        env={
            "DSH_TELEMETRY_DISABLED": "1",
            "DSH_SNAPSHOT": "replay",
            "DSH_SNAPSHOT_FILE": str(SCENARIO / "session.v4.jsonl"),
            "DSH_SNAPSHOT_OVERRIDE": str(SCENARIO / "replay.override.json"),
        },
    ) as harness:
        result = harness.run("Review the current implementation.")

    actual = {
        "finalResponse": result.final_response,
        "finishReason": result.finish_reason,
        "turns": [event["data"]["turn"] for event in result.events if event["type"] == "turn/start"],
        "steps": [
            [event["data"]["turn"], event["data"]["step"]]
            for event in result.events if event["type"] == "step/start"
        ],
        "endings": [event["data"]["reason"] for event in result.events if event["type"] == "turn/end"],
        "assistantMessages": [
            {
                "turn": event["data"]["turn"],
                "step": event["data"]["step"],
                "text": "".join(block["text"] for block in event["data"]["message"]["content"]
                                if block["type"] == "text"),
                "interrupted": event["data"].get("interrupted", False),
            }
            for event in result.events if event["type"] == "assistant/message"
        ],
        "userMessages": [
            "".join(block["text"] for block in event["data"]["content"] if block["type"] == "text")
            for event in result.events
            if event["type"] == "user/message" and event["data"]["source"]["kind"] == "user"
        ],
        "statuses": [notification.payload["status"] for notification in result.notifications
                     if notification.method == "session.status"],
    }
    expected = Path(__file__).with_name("expected") / "response-interrupt.json"
    assert actual == json.loads(expected.read_text())
