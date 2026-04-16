from importlib.util import module_from_spec
from importlib.util import spec_from_file_location
import hmac
import hashlib
from pathlib import Path
import os
import sys
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "openviking" / "tools" / "github_app_review_bot.py"
MODULE_SPEC = spec_from_file_location("github_app_review_bot", MODULE_PATH)
github_app_review_bot = module_from_spec(MODULE_SPEC)
assert MODULE_SPEC.loader is not None
sys.modules[MODULE_SPEC.name] = github_app_review_bot
MODULE_SPEC.loader.exec_module(github_app_review_bot)


class GitHubAppReviewBotTests(unittest.TestCase):
    def test_normalize_private_key(self) -> None:
        self.assertEqual(
            github_app_review_bot.normalize_private_key("line1\\nline2"),
            "line1\nline2",
        )

    def test_verify_github_signature(self) -> None:
        secret = "top-secret"
        body = b'{"hello":"world"}'
        signature = "sha256=" + hmac.new(
            secret.encode("utf-8"),
            body,
            hashlib.sha256,
        ).hexdigest()
        self.assertTrue(github_app_review_bot.verify_github_signature(secret, body, signature))
        self.assertFalse(github_app_review_bot.verify_github_signature(secret, body, "sha256=bad"))

    def test_should_process_issue_comment(self) -> None:
        payload = {
            "action": "created",
            "issue": {"number": 12, "pull_request": {"url": "https://example.test/pr/12"}},
        }
        self.assertTrue(github_app_review_bot.should_process_issue_comment("issue_comment", payload))
        self.assertFalse(github_app_review_bot.should_process_issue_comment("issues", payload))

    def test_resolve_review_handle_prefers_slug(self) -> None:
        previous_slug = os.environ.get("GITHUB_APP_SLUG")
        previous_handle = os.environ.get("REVIEW_BOT_HANDLE")
        try:
            os.environ.pop("REVIEW_BOT_HANDLE", None)
            os.environ["GITHUB_APP_SLUG"] = "my-bot"
            self.assertEqual(github_app_review_bot.resolve_review_handle(), "@my-bot")
        finally:
            if previous_slug is None:
                os.environ.pop("GITHUB_APP_SLUG", None)
            else:
                os.environ["GITHUB_APP_SLUG"] = previous_slug
            if previous_handle is None:
                os.environ.pop("REVIEW_BOT_HANDLE", None)
            else:
                os.environ["REVIEW_BOT_HANDLE"] = previous_handle


if __name__ == "__main__":
    unittest.main()
