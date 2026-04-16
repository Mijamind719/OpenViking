from importlib.util import module_from_spec
from importlib.util import spec_from_file_location
from pathlib import Path
import sys
import unittest


MODULE_PATH = Path(__file__).resolve().parents[1] / "openviking" / "tools" / "github_review_bot.py"
MODULE_SPEC = spec_from_file_location("github_review_bot", MODULE_PATH)
github_review_bot = module_from_spec(MODULE_SPEC)
assert MODULE_SPEC.loader is not None
sys.modules[MODULE_SPEC.name] = github_review_bot
MODULE_SPEC.loader.exec_module(github_review_bot)


class GitHubReviewBotTests(unittest.TestCase):
    def test_extract_trigger_supports_slash_command(self) -> None:
        triggered, guidance = github_review_bot.extract_trigger(
            "/review focus on tests",
            "@openviking-review-bot",
        )
        self.assertTrue(triggered)
        self.assertEqual(guidance, "focus on tests")

    def test_extract_trigger_supports_handle(self) -> None:
        triggered, guidance = github_review_bot.extract_trigger(
            "@openviking-review-bot review check API compatibility",
            "@openviking-review-bot",
        )
        self.assertTrue(triggered)
        self.assertEqual(guidance, "check API compatibility")

    def test_annotate_patch_collects_right_side_lines(self) -> None:
        patch = """@@ -1,3 +1,4 @@
+line1
+line2
-line3
+line3
"""
        numbered_patch, valid_lines = github_review_bot.annotate_patch(patch)
        self.assertIn("R    1 +line1", numbered_patch)
        self.assertIn("R    2 +line2", numbered_patch)
        self.assertIn(1, valid_lines)
        self.assertIn(3, valid_lines)

    def test_sanitize_comments_drops_invalid_lines(self) -> None:
        raw_comments = [
            {"path": "foo.py", "line": 10, "body": "valid", "severity": "high", "title": "Issue"},
            {"path": "foo.py", "line": 99, "body": "invalid"},
        ]

        sanitized = github_review_bot.sanitize_comments(
            raw_comments,
            {"foo.py": {10, 11}},
            max_comments=8,
        )

        self.assertEqual(len(sanitized), 1)
        self.assertEqual(sanitized[0]["path"], "foo.py")
        self.assertEqual(sanitized[0]["line"], 10)
        self.assertEqual(sanitized[0]["side"], "RIGHT")


if __name__ == "__main__":
    unittest.main()
