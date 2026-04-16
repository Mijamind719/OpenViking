"""GitHub App webhook service for AI-powered PR review."""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any

try:
    from openviking.tools.github_review_bot import DEFAULT_REVIEW_BOT_HANDLE
    from openviking.tools.github_review_bot import build_prompt
    from openviking.tools.github_review_bot import build_review_body
    from openviking.tools.github_review_bot import call_model
    from openviking.tools.github_review_bot import create_review
    from openviking.tools.github_review_bot import extract_trigger
    from openviking.tools.github_review_bot import get_env_int
    from openviking.tools.github_review_bot import get_env_text
    from openviking.tools.github_review_bot import load_pr
    from openviking.tools.github_review_bot import load_pr_files
    from openviking.tools.github_review_bot import post_issue_comment
    from openviking.tools.github_review_bot import request_json
    from openviking.tools.github_review_bot import sanitize_comments
except Exception:  # pragma: no cover - fallback for lightweight local tests
    helper_path = Path(__file__).resolve().with_name("github_review_bot.py")
    helper_spec = importlib.util.spec_from_file_location("github_review_bot_fallback", helper_path)
    if helper_spec is None or helper_spec.loader is None:
        raise RuntimeError(f"Unable to load helper module from {helper_path}")
    helper_module = importlib.util.module_from_spec(helper_spec)
    sys.modules[helper_spec.name] = helper_module
    helper_spec.loader.exec_module(helper_module)

    DEFAULT_REVIEW_BOT_HANDLE = helper_module.DEFAULT_REVIEW_BOT_HANDLE
    build_prompt = helper_module.build_prompt
    build_review_body = helper_module.build_review_body
    call_model = helper_module.call_model
    create_review = helper_module.create_review
    extract_trigger = helper_module.extract_trigger
    get_env_int = helper_module.get_env_int
    get_env_text = helper_module.get_env_text
    load_pr = helper_module.load_pr
    load_pr_files = helper_module.load_pr_files
    post_issue_comment = helper_module.post_issue_comment
    request_json = helper_module.request_json
    sanitize_comments = helper_module.sanitize_comments


LOGGER = logging.getLogger("openviking.github_app_review_bot")


def normalize_private_key(value: str) -> str:
    """Turn escaped newlines into a PEM-friendly private key string."""

    return value.strip().replace("\\n", "\n")


def load_app_private_key() -> str:
    key_path = os.getenv("GITHUB_APP_PRIVATE_KEY_PATH", "").strip()
    if key_path:
        return Path(key_path).read_text(encoding="utf-8")

    private_key = os.getenv("GITHUB_APP_PRIVATE_KEY", "").strip()
    if private_key:
        return normalize_private_key(private_key)

    raise RuntimeError(
        "GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required for GitHub App auth"
    )


def verify_github_signature(secret: str, body: bytes, signature_header: str | None) -> bool:
    if not signature_header or not signature_header.startswith("sha256="):
        return False

    digest = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    expected = f"sha256={digest}"
    return hmac.compare_digest(expected, signature_header)


def should_process_issue_comment(event_name: str, payload: dict[str, Any]) -> bool:
    if event_name != "issue_comment":
        return False
    if payload.get("action") != "created":
        return False
    issue = payload.get("issue") or {}
    return bool(issue.get("pull_request"))


def resolve_review_handle() -> str:
    explicit = os.getenv("REVIEW_BOT_HANDLE", "").strip()
    if explicit:
        return explicit

    slug = os.getenv("GITHUB_APP_SLUG", "").strip().lstrip("@")
    if slug:
        return f"@{slug}"

    return DEFAULT_REVIEW_BOT_HANDLE


def create_app_jwt() -> str:
    try:
        import jwt
    except ImportError as exc:  # pragma: no cover - dependency is declared in pyproject
        raise RuntimeError("PyJWT[crypto] is required to authenticate as a GitHub App") from exc

    app_id = os.getenv("GITHUB_APP_ID", "").strip()
    if not app_id:
        raise RuntimeError("GITHUB_APP_ID is required")

    now = int(time.time())
    payload = {
        "iat": now - 60,
        "exp": now + 540,
        "iss": app_id,
    }
    return jwt.encode(payload, load_app_private_key(), algorithm="RS256")


def create_installation_token(installation_id: int) -> str:
    api_base = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    response = request_json(
        "POST",
        f"{api_base}/app/installations/{installation_id}/access_tokens",
        create_app_jwt(),
        payload={},
    )
    token = str((response or {}).get("token") or "").strip()
    if not token:
        raise RuntimeError("GitHub did not return an installation token")
    return token


def process_issue_comment_event(payload: dict[str, Any]) -> None:
    issue = payload.get("issue") or {}
    comment = payload.get("comment") or {}
    repository = payload.get("repository") or {}
    installation = payload.get("installation") or {}

    if (comment.get("user") or {}).get("type") == "Bot":
        LOGGER.info("Skipping bot-authored comment")
        return

    handle = resolve_review_handle()
    triggered, guidance = extract_trigger(comment.get("body") or "", handle)
    if not triggered:
        LOGGER.info("Comment did not match review trigger")
        return

    repo = str(repository.get("full_name") or "").strip()
    if not repo:
        raise RuntimeError("Webhook payload did not include repository.full_name")

    installation_id = installation.get("id")
    if not installation_id:
        raise RuntimeError("Webhook payload did not include installation.id")

    pull_number = int(issue["number"])
    token = create_installation_token(int(installation_id))

    try:
        pr = load_pr(repo, pull_number, token)
        files = load_pr_files(repo, pull_number, token)
        max_comments = get_env_int("REVIEW_MAX_COMMENTS", 8)

        prompt, valid_lines_by_path, truncated_count = build_prompt(
            pr=pr,
            files=files,
            guidance=guidance,
            max_files=get_env_int("REVIEW_MAX_FILES", 15),
            max_patch_chars=get_env_int("REVIEW_MAX_PATCH_CHARS", 50000),
            max_comments=max_comments,
        )

        model_result = call_model(prompt)
        inline_comments = sanitize_comments(
            raw_comments=model_result.get("comments") or [],
            valid_lines_by_path=valid_lines_by_path,
            max_comments=max_comments,
        )

        review_body = build_review_body(
            summary=str(model_result.get("summary") or "").strip(),
            overall_risk=str(model_result.get("overall_risk") or "medium").strip().lower(),
            guidance=guidance,
            inline_comment_count=len(inline_comments),
            truncated_count=truncated_count,
        )

        create_review(
            repo=repo,
            pull_number=pull_number,
            token=token,
            body=review_body,
            commit_id=pr["head"]["sha"],
            comments=inline_comments,
        )
        LOGGER.info("Created AI review for %s#%s", repo, pull_number)
    except Exception as exc:  # pragma: no cover - network and third-party failures
        LOGGER.exception("Failed to review %s#%s", repo, pull_number)
        error_message = (
            "GitHub App AI review failed to complete this request.\n\n"
            f"- Trigger comment: `{comment.get('body', '').strip()}`\n"
            f"- Error: `{type(exc).__name__}`\n"
            f"- Detail: `{str(exc)[:500]}`"
        )
        try:
            post_issue_comment(repo, pull_number, token, error_message)
        except Exception:
            LOGGER.exception("Failed to post fallback issue comment for %s#%s", repo, pull_number)


def create_app():
    from fastapi import BackgroundTasks
    from fastapi import FastAPI
    from fastapi import Header
    from fastapi import HTTPException
    from fastapi import Request

    app = FastAPI(title="OpenViking GitHub App Review Bot", version="0.1.0")

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/github/webhook", status_code=202)
    async def github_webhook(
        request: Request,
        background_tasks: BackgroundTasks,
        x_github_event: str = Header(default=""),
        x_hub_signature_256: str | None = Header(default=None),
        x_github_delivery: str | None = Header(default=None),
    ) -> dict[str, Any]:
        body = await request.body()
        secret = get_env_text("GITHUB_WEBHOOK_SECRET", "")
        if not secret:
            raise HTTPException(status_code=500, detail="GITHUB_WEBHOOK_SECRET is not configured")

        if not verify_github_signature(secret, body, x_hub_signature_256):
            raise HTTPException(status_code=401, detail="Invalid webhook signature")

        payload = json.loads(body.decode("utf-8"))

        if x_github_event == "ping":
            return {"ok": True, "message": "pong"}

        if not should_process_issue_comment(x_github_event, payload):
            return {"ok": True, "queued": False, "reason": "unsupported event"}

        background_tasks.add_task(process_issue_comment_event, payload)
        return {
            "ok": True,
            "queued": True,
            "event": x_github_event,
            "delivery_id": x_github_delivery,
        }

    return app


def main() -> None:
    import uvicorn

    logging.basicConfig(
        level=get_env_text("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    uvicorn.run(
        create_app(),
        host=get_env_text("HOST", "0.0.0.0"),
        port=get_env_int("PORT", 8000),
    )


if __name__ == "__main__":
    main()
