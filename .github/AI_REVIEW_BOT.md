# AI Review Bot

This repository includes an Actions-based review bot that can review a pull request when someone comments on the PR.

## How it works

1. A user comments `/review` or `@openviking-review-bot review` on a PR.
2. GitHub Actions reads the PR metadata and changed-file patches through the GitHub API.
3. The workflow sends the diff to a configured LLM.
4. The bot posts a PR review with a summary and inline review comments on changed lines.

## Required setup

Add these repository secrets:

- `OPENAI_API_KEY`: API key for the model provider.
- `OPENAI_BASE_URL`: Optional. Set this only if you use a compatible endpoint instead of `https://api.openai.com/v1`.

Optional repository variables:

- `OPENAI_MODEL`: Defaults to `gpt-4.1-mini`.
- `REVIEW_BOT_HANDLE`: Defaults to `@openviking-review-bot`.
- `REVIEW_MAX_COMMENTS`: Defaults to `8`.
- `REVIEW_MAX_FILES`: Defaults to `15`.
- `REVIEW_MAX_PATCH_CHARS`: Defaults to `50000`.

## Usage

Comment on a pull request with one of these commands:

```text
/review
```

```text
/review focus on concurrency and error handling
```

```text
@openviking-review-bot review
```

```text
@openviking-review-bot review focus on API compatibility
```

## Notes

- The workflow reviews only the diff that GitHub exposes for the PR.
- Inline comments are created only on right-side diff lines that still exist in the changed files.
- Large PRs are truncated before they are sent to the model. The summary comment will mention how many files were omitted.
- This bot posts a `COMMENT` review instead of `APPROVE` or `REQUEST_CHANGES`, so it will not block merges by itself.
- For public repositories with fork-based PRs, GitHub may require a maintainer to approve workflow runs before the action can use repository secrets.
