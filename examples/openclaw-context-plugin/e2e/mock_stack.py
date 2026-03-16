#!/usr/bin/env python3

import argparse
import json
import re
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(normalize_text(item) for item in value)
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        if "content" in value:
            return normalize_text(value["content"])
    return ""


def message_text(message: dict[str, Any]) -> str:
    return normalize_text(message.get("content") or message)


def score_text(query: str, text: str) -> float:
    query_tokens = [token for token in re.split(r"\W+", query.lower()) if token]
    if not query_tokens:
        return 0.0
    haystack = text.lower()
    matches = sum(1 for token in query_tokens if token in haystack)
    return matches / len(query_tokens)


def compact_json(data: Any) -> bytes:
    return json.dumps(data, ensure_ascii=False).encode("utf-8")


def chunk_text(text: str, size: int = 24) -> list[str]:
    return [text[index : index + size] for index in range(0, len(text), size)] or [""]


@dataclass
class MockState:
    state_file: Path
    sessions: dict[str, dict[str, Any]] = field(default_factory=dict)
    memories: dict[str, dict[str, Any]] = field(default_factory=dict)
    resources: dict[str, dict[str, Any]] = field(
        default_factory=lambda: {
            "viking://resources/mock/context-openviking.md": {
                "uri": "viking://resources/mock/context-openviking.md",
                "abstract": "Mock OpenViking resource for E2E testing",
                "content": "This is a mock resource exposed by the OpenViking E2E harness.",
                "category": "resource",
            }
        }
    )
    requests: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def save(self) -> None:
        with self.lock:
            payload = {
                "sessions": self.sessions,
                "memories": self.memories,
                "resources": self.resources,
                "requests": self.requests[-200:],
            }
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            self.state_file.write_text(json.dumps(payload, indent=2, ensure_ascii=False), "utf-8")

    def add_request(self, kind: str, path: str, body: Any) -> None:
        with self.lock:
            self.requests.append(
                {
                    "ts": now_ms(),
                    "kind": kind,
                    "path": path,
                    "body": body,
                }
            )
        self.save()

    def ensure_session(self, session_id: str) -> dict[str, Any]:
        with self.lock:
            session = self.sessions.setdefault(
                session_id,
                {
                    "session_id": session_id,
                    "messages": [],
                    "history": [],
                    "commit_count": 0,
                },
            )
            return session

    def extract_memories(
        self, session_id: str, messages: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        extracted: list[dict[str, Any]] = []
        for message in messages:
            text = message_text(message)
            match = re.search(r"favorite editor is ([A-Za-z0-9._-]+)", text, re.I)
            if match:
                value = match.group(1)
                uri = "viking://user/default/memories/preferences/editor.md"
                memory = {
                    "uri": uri,
                    "abstract": f"Favorite editor: {value}",
                    "overview": f"User preference: favorite editor is {value}.",
                    "content": f"favorite editor is {value}",
                    "category": "preference",
                    "score": 1.0,
                }
                self.memories[uri] = memory
                extracted.append(memory)
        self.save()
        return extracted

    def commit_session(self, session_id: str) -> dict[str, Any]:
        session = self.ensure_session(session_id)
        messages = list(session["messages"])
        if not messages:
            return {
                "session_id": session_id,
                "status": "committed",
                "memories_extracted": 0,
                "active_count_updated": 0,
                "archived": False,
                "stats": {"history_count": len(session["history"])},
            }

        session["commit_count"] += 1
        archive_index = session["commit_count"]
        archive_uri = f"viking://session/default/{session_id}/history/archive_{archive_index:03d}"
        summary = "\n".join(message_text(message) for message in messages)
        extracted = self.extract_memories(session_id, messages)
        session["history"].append(
            {
                "uri": archive_uri,
                "messages": messages,
                "summary": summary,
                "content": summary,
            }
        )
        session["messages"] = []
        self.save()
        return {
            "session_id": session_id,
            "status": "committed",
            "memories_extracted": len(extracted),
            "active_count_updated": len(extracted),
            "archived": True,
            "stats": {"history_count": len(session["history"])},
        }

    def search(self, target_uri: str, query: str, limit: int) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        if "/history" in target_uri:
            session_id_match = re.search(r"/([0-9a-f-]{6,}|e2e-[^/]+)/history", target_uri)
            if session_id_match:
                session_id = session_id_match.group(1)
                session = self.sessions.get(session_id)
                if session:
                    for archive in session["history"]:
                        score = score_text(query, archive["summary"])
                        if score > 0:
                            items.append(
                                {
                                    "uri": archive["uri"],
                                    "abstract": archive["summary"][:160],
                                    "overview": archive["summary"],
                                    "category": "session-history",
                                    "score": score,
                                }
                            )
        elif "/memories" in target_uri:
            for memory in self.memories.values():
                score = score_text(query, memory["content"])
                if score > 0:
                    items.append(
                        {k: v for k, v in memory.items() if k != "content"} | {"score": score}
                    )
        elif "resources" in target_uri:
            for resource in self.resources.values():
                score = score_text(query, resource["content"])
                if score > 0:
                    items.append(
                        {
                            "uri": resource["uri"],
                            "abstract": resource["abstract"],
                            "overview": resource["content"],
                            "category": "resource",
                            "score": score,
                        }
                    )

        items.sort(key=lambda item: item.get("score", 0), reverse=True)
        items = items[:limit]
        if "/memories" in target_uri:
            return {"memories": items, "total": len(items)}
        if "skills" in target_uri:
            return {"skills": items, "total": len(items)}
        return {"resources": items, "memories": [], "skills": [], "total": len(items)}

    def read_uri(self, uri: str) -> str:
        if uri in self.memories:
            return self.memories[uri]["content"]
        if uri in self.resources:
            return self.resources[uri]["content"]
        for session in self.sessions.values():
            for archive in session["history"]:
                if archive["uri"] == uri:
                    return archive["content"]
        return ""


def latest_user_text(messages: list[dict[str, Any]]) -> str:
    for message in reversed(messages):
        if message.get("role") == "user":
            return message_text(message)
    return ""


def has_context_block(messages: list[dict[str, Any]], marker: str) -> bool:
    return any(marker in message_text(message) for message in messages)


def latest_tool_message(messages: list[dict[str, Any]]) -> dict[str, Any] | None:
    for message in reversed(messages):
        if message.get("role") == "tool":
            return message
    return None


class MockHandler(BaseHTTPRequestHandler):
    server_version = "MockOpenVikingOpenAI/1.0"

    @property
    def state(self) -> MockState:
        return self.server.state  # type: ignore[attr-defined]

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("content-length", "0") or "0")
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _send(self, payload: Any, status: int = 200) -> None:
        body = compact_json(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_openai_stream(self, chunks: list[dict[str, Any]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        for chunk in chunks:
            payload = f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8")
            self.wfile.write(payload)
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def _send_openai_error(
        self, status: int, message: str, code: str = "context_length_exceeded"
    ) -> None:
        self._send(
            {
                "error": {
                    "message": message,
                    "type": "invalid_request_error",
                    "code": code,
                }
            },
            status=status,
        )

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        self.state.add_request("GET", self.path, None)

        if parsed.path == "/health":
            self._send({"status": "ok"})
            return

        if parsed.path == "/api/v1/system/status":
            self._send({"status": "ok", "result": {"user": "default"}})
            return

        if parsed.path == "/api/v1/fs/ls":
            uri = parse_qs(parsed.query).get("uri", [""])[0]
            if uri == "viking://user":
                self._send({"status": "ok", "result": [{"name": "default", "isDir": True}]})
                return
            if uri == "viking://agent":
                self._send({"status": "ok", "result": [{"name": "default", "isDir": True}]})
                return
            self._send({"status": "ok", "result": []})
            return

        if parsed.path.startswith("/api/v1/sessions/"):
            session_id = parsed.path.split("/")[4]
            session = self.state.ensure_session(session_id)
            self._send(
                {
                    "status": "ok",
                    "result": {
                        "session_id": session_id,
                        "message_count": len(session["messages"]),
                    },
                }
            )
            return

        if parsed.path == "/api/v1/content/read":
            uri = parse_qs(parsed.query).get("uri", [""])[0]
            self._send({"status": "ok", "result": self.state.read_uri(uri)})
            return

        self._send({"status": "error", "error": {"message": f"Unhandled GET {parsed.path}"}}, 404)

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        self.state.add_request("DELETE", self.path, None)

        if parsed.path.startswith("/api/v1/sessions/"):
            session_id = parsed.path.split("/")[4]
            self.state.sessions.pop(session_id, None)
            self.state.save()
            self._send({"status": "ok", "result": {"deleted": True, "session_id": session_id}})
            return

        if parsed.path == "/api/v1/fs":
            uri = parse_qs(parsed.query).get("uri", [""])[0]
            self.state.memories.pop(uri, None)
            self.state.resources.pop(uri, None)
            self.state.save()
            self._send({"status": "ok", "result": {"deleted": True, "uri": uri}})
            return

        self._send(
            {"status": "error", "error": {"message": f"Unhandled DELETE {parsed.path}"}}, 404
        )

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        body = self._read_json()
        self.state.add_request("POST", self.path, body)

        if parsed.path == "/api/v1/sessions":
            session_id = body.get("session_id") or f"ov-{uuid.uuid4().hex[:12]}"
            self.state.ensure_session(session_id)
            self.state.save()
            self._send({"status": "ok", "result": {"session_id": session_id}})
            return

        if parsed.path.endswith("/messages") and parsed.path.startswith("/api/v1/sessions/"):
            session_id = parsed.path.split("/")[4]
            session = self.state.ensure_session(session_id)
            session["messages"].append(
                {
                    "role": body.get("role", "user"),
                    "content": body.get("content", ""),
                }
            )
            self.state.save()
            self._send(
                {
                    "status": "ok",
                    "result": {"session_id": session_id, "message_count": len(session["messages"])},
                }
            )
            return

        if parsed.path.endswith("/commit") and parsed.path.startswith("/api/v1/sessions/"):
            session_id = parsed.path.split("/")[4]
            result = self.state.commit_session(session_id)
            self._send({"status": "ok", "result": result})
            return

        if parsed.path.endswith("/extract") and parsed.path.startswith("/api/v1/sessions/"):
            session_id = parsed.path.split("/")[4]
            session = self.state.ensure_session(session_id)
            extracted = self.state.extract_memories(session_id, session["messages"])
            self._send({"status": "ok", "result": extracted})
            return

        if parsed.path == "/api/v1/search/find":
            result = self.state.search(
                body.get("target_uri", ""),
                body.get("query", ""),
                int(body.get("limit", 6) or 6),
            )
            self._send({"status": "ok", "result": result})
            return

        if parsed.path.endswith("/chat/completions"):
            messages = body.get("messages", []) if isinstance(body.get("messages"), list) else []
            stream = body.get("stream") is True
            model = body.get("model", "mock-e2e")
            latest_user = latest_user_text(messages).lower()
            tool_message = latest_tool_message(messages)
            joined_non_system = "\n".join(
                message_text(message) for message in messages if message.get("role") != "system"
            )
            has_profile_context = has_context_block(
                messages, "<openviking-user-profile>"
            ) or has_context_block(messages, "<openviking-durable-memory>")
            request_id = f"chatcmpl-{uuid.uuid4().hex[:10]}"
            created = int(time.time())

            if (
                "what is my favorite editor" in latest_user
                and len(joined_non_system) > 1200
                and not has_profile_context
            ):
                self._send_openai_error(
                    400,
                    "This model's maximum context length has been exceeded. Please reduce the length of the messages.",
                )
                return

            if "use ov_recall" in latest_user and tool_message is None:
                tool_call_id = f"call_{uuid.uuid4().hex[:10]}"
                arguments = json.dumps(
                    {
                        "query": "favorite editor",
                        "scopes": ["memory"],
                    }
                )
                if stream:
                    self._send_openai_stream(
                        [
                            {
                                "id": request_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model,
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": {"role": "assistant"},
                                        "finish_reason": None,
                                    }
                                ],
                            },
                            {
                                "id": request_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model,
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": {
                                            "tool_calls": [
                                                {
                                                    "index": 0,
                                                    "id": tool_call_id,
                                                    "type": "function",
                                                    "function": {
                                                        "name": "ov_recall",
                                                        "arguments": arguments,
                                                    },
                                                }
                                            ]
                                        },
                                        "finish_reason": None,
                                    }
                                ],
                            },
                            {
                                "id": request_id,
                                "object": "chat.completion.chunk",
                                "created": created,
                                "model": model,
                                "choices": [
                                    {
                                        "index": 0,
                                        "delta": {},
                                        "finish_reason": "tool_calls",
                                    }
                                ],
                                "usage": {
                                    "prompt_tokens": 1,
                                    "completion_tokens": 1,
                                    "total_tokens": 2,
                                },
                            },
                        ]
                    )
                    return
                self._send(
                    {
                        "id": request_id,
                        "object": "chat.completion",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "finish_reason": "tool_calls",
                                "message": {
                                    "role": "assistant",
                                    "content": None,
                                    "tool_calls": [
                                        {
                                            "id": tool_call_id,
                                            "type": "function",
                                            "function": {
                                                "name": "ov_recall",
                                                "arguments": arguments,
                                            },
                                        }
                                    ],
                                },
                            }
                        ],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    }
                )
                return

            if tool_message is not None:
                text = message_text(tool_message).lower()
                answer = "TOOL_OK neovim" if "neovim" in text else "TOOL_OK unknown"
            elif "what is my favorite editor" in latest_user:
                if has_profile_context:
                    joined = "\n".join(message_text(message).lower() for message in messages)
                    answer = "neovim" if "neovim" in joined else "unknown"
                else:
                    answer = "unknown"
            elif "remember that my favorite editor is neovim" in latest_user:
                answer = "Noted."
            else:
                answer = "OK"

            if stream:
                chunks = [
                    {
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant"},
                                "finish_reason": None,
                            }
                        ],
                    }
                ]
                for part in chunk_text(answer):
                    chunks.append(
                        {
                            "id": request_id,
                            "object": "chat.completion.chunk",
                            "created": created,
                            "model": model,
                            "choices": [
                                {
                                    "index": 0,
                                    "delta": {"content": part},
                                    "finish_reason": None,
                                }
                            ],
                        }
                    )
                chunks.append(
                    {
                        "id": request_id,
                        "object": "chat.completion.chunk",
                        "created": created,
                        "model": model,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {},
                                "finish_reason": "stop",
                            }
                        ],
                        "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                    }
                )
                self._send_openai_stream(chunks)
                return

            self._send(
                {
                    "id": request_id,
                    "object": "chat.completion",
                    "created": created,
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": answer,
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                }
            )
            return

        self._send({"status": "error", "error": {"message": f"Unhandled POST {parsed.path}"}}, 404)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return


def main() -> None:
    parser = argparse.ArgumentParser(description="Mock OpenViking + OpenAI stack for OpenClaw E2E.")
    parser.add_argument("--port", type=int, default=19401)
    parser.add_argument(
        "--state-file",
        default="/tmp/context-openviking-e2e-state.json",
    )
    args = parser.parse_args()

    state = MockState(state_file=Path(args.state_file))
    state.save()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), MockHandler)
    server.state = state  # type: ignore[attr-defined]
    print(f"mock-stack listening on http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
