"""GitHub PR review bot triggered from PR comments."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_REVIEW_BOT_HANDLE = "@openviking-review-bot"
DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1"
DEFAULT_OPENAI_MODEL = "gpt-4.1-mini"
DEFAULT_MAX_FILES = 15
DEFAULT_MAX_PATCH_CHARS = 50000
DEFAULT_MAX_COMMENTS = 8
DEFAULT_TIMEOUT_SECONDS = 90

HUNK_HEADER_RE = re.compile(r"^@@ -(?P<old>\d+)(?:,\d+)? \+(?P<new>\d+)(?:,\d+)? @@")


@dataclass
class ReviewCandidate:
    path: str
    body: str
    line: int
    severity: str = "medium"
    title: str = ""


class GitHubApiError(RuntimeError):
    """Raised when a GitHub REST call fails."""


def get_env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


def get_env_text(name: str, default: str) -> str:
    raw = os.getenv(name)
    if raw is None:
        return default
    raw = raw.strip()
    return raw or default


def request_json(
    method: str,
    url: str,
    token: str,
    payload: dict[str, Any] | None = None,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
) -> dict[str, Any] | list[Any]:
    data = None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "openviking-review-bot",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = response.read().decode("utf-8")
            if not body:
                return {}
            return json.loads(body)
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise GitHubApiError(f"{method} {url} failed: {exc.code} {details}") from exc


def post_issue_comment(repo: str, issue_number: int, token: str, body: str) -> None:
    api_base = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    request_json(
        "POST",
        f"{api_base}/repos/{repo}/issues/{issue_number}/comments",
        token,
        payload={"body": body},
    )


def create_review(
    repo: str,
    pull_number: int,
    token: str,
    body: str,
    commit_id: str,
    comments: list[dict[str, Any]],
) -> None:
    api_base = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    payload: dict[str, Any] = {
        "body": body,
        "event": "COMMENT",
        "commit_id": commit_id,
    }
    if comments:
        payload["comments"] = comments
    request_json(
        "POST",
        f"{api_base}/repos/{repo}/pulls/{pull_number}/reviews",
        token,
        payload=payload,
    )


def read_event() -> dict[str, Any]:
    event_path = os.getenv("GITHUB_EVENT_PATH")
    if not event_path:
        raise RuntimeError("GITHUB_EVENT_PATH is required")
    return json.loads(Path(event_path).read_text(encoding="utf-8"))


def extract_trigger(body: str, handle: str) -> tuple[bool, str]:
    normalized = body.strip()
    lowered = normalized.lower()
    lowered_handle = handle.lower()

    if "/review" in lowered:
        guidance = re.sub(r"(?i)/review\b", "", normalized, count=1).strip(" \n:-")
        return True, guidance

    if lowered_handle and lowered_handle in lowered:
        guidance = re.sub(re.escape(handle), "", normalized, count=1, flags=re.IGNORECASE)
        guidance = re.sub(r"(?i)\breview\b", "", guidance, count=1).strip(" \n:-")
        return True, guidance

    return False, ""


def annotate_patch(patch: str) -> tuple[str, set[int]]:
    """Add right-side line numbers to a unified diff patch."""

    old_line = 0
    new_line = 0
    valid_lines: set[int] = set()
    numbered: list[str] = []

    for raw_line in patch.splitlines():
        if raw_line.startswith("@@"):
            match = HUNK_HEADER_RE.match(raw_line)
            if not match:
                numbered.append(raw_line)
                continue
            old_line = int(match.group("old"))
            new_line = int(match.group("new"))
            numbered.append(raw_line)
            continue

        if raw_line.startswith("+") and not raw_line.startswith("+++"):
            valid_lines.add(new_line)
            numbered.append(f"R{new_line:>5} {raw_line}")
            new_line += 1
            continue

        if raw_line.startswith(" ") or raw_line == "":
            valid_lines.add(new_line)
            numbered.append(f"R{new_line:>5} {raw_line}")
            old_line += 1
            new_line += 1
            continue

        if raw_line.startswith("-") and not raw_line.startswith("---"):
            numbered.append(f"L{old_line:>5} {raw_line}")
            old_line += 1
            continue

        numbered.append(raw_line)

    return "\n".join(numbered), valid_lines


def build_prompt(
    pr: dict[str, Any],
    files: list[dict[str, Any]],
    guidance: str,
    max_files: int,
    max_patch_chars: int,
    max_comments: int,
) -> tuple[str, dict[str, set[int]], int]:
    included_sections: list[str] = []
    valid_lines_by_path: dict[str, set[int]] = {}
    used_chars = 0
    truncated_count = 0

    for index, pr_file in enumerate(files):
        if index >= max_files:
            truncated_count = len(files) - index
            break

        filename = pr_file["filename"]
        patch = pr_file.get("patch")
        status = pr_file.get("status", "modified")

        if not patch:
            included_sections.append(
                f"FILE: {filename}\nSTATUS: {status}\nNOTE: Diff patch unavailable (binary, too large, or generated)."
            )
            continue

        numbered_patch, valid_lines = annotate_patch(patch)
        section = (
            f"FILE: {filename}\n"
            f"STATUS: {status}\n"
            f"ADDITIONS: {pr_file.get('additions', 0)}  DELETIONS: {pr_file.get('deletions', 0)}\n"
            "PATCH:\n"
            f"{numbered_patch}\n"
        )

        if used_chars + len(section) > max_patch_chars:
            truncated_count = len(files) - index
            break

        used_chars += len(section)
        included_sections.append(section)
        valid_lines_by_path[filename] = valid_lines

    guidance_text = guidance or "No extra reviewer instructions were provided."
    prompt = f"""
You are an experienced code reviewer. Review this pull request and return ONLY valid JSON.

Review goals:
- Focus on correctness, regressions, security, performance, data loss, concurrency, API contract breaks, and missing tests.
- Ignore nits unless they hide a real bug or maintenance risk.
- Only comment on lines that exist on the RIGHT side of the diff.
- Use only line numbers that appear as `R<number>` in the numbered patches.
- Do not invent file paths or line numbers.
- Limit findings to at most {max_comments} actionable comments.
- If there are no actionable findings, return an empty comments array.

JSON schema:
{{
  "summary": "short markdown summary",
  "overall_risk": "low|medium|high",
  "comments": [
    {{
      "path": "relative/file.py",
      "line": 123,
      "severity": "low|medium|high",
      "title": "short finding title",
      "body": "1-3 sentences explaining the issue and a concrete fix"
    }}
  ]
}}

Pull request metadata:
- Title: {pr.get("title", "").strip()}
- Author: {pr.get("user", {}).get("login", "unknown")}
- Base branch: {pr.get("base", {}).get("ref", "")}
- Head branch: {pr.get("head", {}).get("ref", "")}
- Requested focus: {guidance_text}

Pull request description:
{pr.get("body") or "(no description provided)"}

Changed files:
{chr(10).join(included_sections)}
""".strip()

    return prompt, valid_lines_by_path, truncated_count


def extract_message_content(response_payload: dict[str, Any]) -> str:
    choices = response_payload.get("choices") or []
    if not choices:
        raise RuntimeError("Model response did not include choices")
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        text_parts = [part.get("text", "") for part in content if isinstance(part, dict)]
        return "".join(text_parts)
    raise RuntimeError("Unsupported model response shape")


def call_model(prompt: str) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required")

    model = get_env_text("OPENAI_MODEL", DEFAULT_OPENAI_MODEL)
    base_url = get_env_text("OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL).rstrip("/")
    timeout = get_env_int("OPENAI_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS)

    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a careful senior engineer reviewing a GitHub pull request. "
                    "Return strict JSON only."
                ),
            },
            {"role": "user", "content": prompt},
        ],
    }

    request = urllib.request.Request(
        f"{base_url}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "openviking-review-bot",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Model request failed: {exc.code} {details}") from exc

    content = extract_message_content(json.loads(raw_body))
    return parse_model_json(content)


def parse_model_json(raw_content: str) -> dict[str, Any]:
    content = raw_content.strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content)
        content = re.sub(r"\s*```$", "", content)

    start = content.find("{")
    end = content.rfind("}")
    if start == -1 or end == -1:
        raise RuntimeError(f"Model output was not JSON: {raw_content}")

    return json.loads(content[start : end + 1])


def normalize_comment(comment: dict[str, Any]) -> ReviewCandidate | None:
    path = str(comment.get("path") or "").strip()
    if not path:
        return None

    try:
        line = int(comment.get("line"))
    except (TypeError, ValueError):
        return None

    body = str(comment.get("body") or "").strip()
    title = str(comment.get("title") or "").strip()
    severity = str(comment.get("severity") or "medium").strip().lower()
    if not body:
        return None

    return ReviewCandidate(
        path=path,
        line=line,
        body=body,
        title=title,
        severity=severity if severity in {"low", "medium", "high"} else "medium",
    )


def sanitize_comments(
    raw_comments: list[dict[str, Any]],
    valid_lines_by_path: dict[str, set[int]],
    max_comments: int,
) -> list[dict[str, Any]]:
    sanitized: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()

    for raw_comment in raw_comments:
        candidate = normalize_comment(raw_comment)
        if not candidate:
            continue

        allowed_lines = valid_lines_by_path.get(candidate.path)
        if not allowed_lines or candidate.line not in allowed_lines:
            continue

        key = (candidate.path, candidate.line)
        if key in seen:
            continue

        seen.add(key)
        body_lines = []
        if candidate.title:
            body_lines.append(f"**{candidate.title}**")
        body_lines.append(f"Severity: `{candidate.severity}`")
        body_lines.append(candidate.body)

        sanitized.append(
            {
                "path": candidate.path,
                "line": candidate.line,
                "side": "RIGHT",
                "body": "\n\n".join(body_lines),
            }
        )

        if len(sanitized) >= max_comments:
            break

    return sanitized


def build_review_body(
    summary: str,
    overall_risk: str,
    guidance: str,
    inline_comment_count: int,
    truncated_count: int,
) -> str:
    lines = [
        "## AI Review",
        f"- Overall risk: `{overall_risk}`",
        f"- Inline comments: `{inline_comment_count}`",
    ]

    if guidance:
        lines.append(f"- Requested focus: {guidance}")
    if truncated_count:
        lines.append(f"- Omitted files from model context due to limits: `{truncated_count}`")

    lines.append("")
    lines.append(summary or "No actionable issues were identified in the reviewed diff.")
    lines.append("")
    lines.append(
        "_This review is generated from the PR diff and should be treated as a second pair of eyes, not a merge gate._"
    )
    return "\n".join(lines)


def load_pr(repo: str, pull_number: int, token: str) -> dict[str, Any]:
    api_base = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    return request_json(
        "GET",
        f"{api_base}/repos/{repo}/pulls/{pull_number}",
        token,
    )


def load_pr_files(repo: str, pull_number: int, token: str) -> list[dict[str, Any]]:
    api_base = os.getenv("GITHUB_API_URL", "https://api.github.com").rstrip("/")
    files: list[dict[str, Any]] = []
    page = 1

    while True:
        batch = request_json(
            "GET",
            f"{api_base}/repos/{repo}/pulls/{pull_number}/files?per_page=100&page={page}",
            token,
        )
        if not isinstance(batch, list) or not batch:
            break
        files.extend(batch)
        page += 1

    return files


def main() -> int:
    event = read_event()
    issue = event.get("issue") or {}
    comment = event.get("comment") or {}

    if not issue.get("pull_request"):
        print("Comment is not on a pull request. Skipping.")
        return 0

    if (comment.get("user") or {}).get("type") == "Bot":
        print("Bot comment detected. Skipping.")
        return 0

    handle = get_env_text("REVIEW_BOT_HANDLE", DEFAULT_REVIEW_BOT_HANDLE)
    triggered, guidance = extract_trigger(comment.get("body") or "", handle)
    if not triggered:
        print("Comment does not trigger the review bot. Skipping.")
        return 0

    repo = os.getenv("GITHUB_REPOSITORY")
    token = os.getenv("GITHUB_TOKEN")
    if not repo or not token:
        raise RuntimeError("GITHUB_REPOSITORY and GITHUB_TOKEN are required")

    pull_number = int(issue["number"])

    try:
        pr = load_pr(repo, pull_number, token)
        files = load_pr_files(repo, pull_number, token)

        prompt, valid_lines_by_path, truncated_count = build_prompt(
            pr=pr,
            files=files,
            guidance=guidance,
            max_files=get_env_int("REVIEW_MAX_FILES", DEFAULT_MAX_FILES),
            max_patch_chars=get_env_int("REVIEW_MAX_PATCH_CHARS", DEFAULT_MAX_PATCH_CHARS),
            max_comments=get_env_int("REVIEW_MAX_COMMENTS", DEFAULT_MAX_COMMENTS),
        )

        model_result = call_model(prompt)
        inline_comments = sanitize_comments(
            raw_comments=model_result.get("comments") or [],
            valid_lines_by_path=valid_lines_by_path,
            max_comments=get_env_int("REVIEW_MAX_COMMENTS", DEFAULT_MAX_COMMENTS),
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
    except Exception as exc:  # pragma: no cover - best effort failure notice
        error_message = (
            "AI review bot failed to complete this request.\n\n"
            f"- Trigger comment: `{comment.get('body', '').strip()}`\n"
            f"- Error: `{type(exc).__name__}`\n"
            f"- Detail: `{str(exc)[:500]}`"
        )
        try:
            post_issue_comment(repo, pull_number, token, error_message)
        except Exception:
            pass
        raise

    return 0


if __name__ == "__main__":
    sys.exit(main())
