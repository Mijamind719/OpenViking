# GitHub App Review Bot

This repository also includes a GitHub App version of the review bot. Use this variant if you want one bot identity that can review pull requests across any repository where the app is installed.

## What this changes

- The bot is no longer tied to one repository workflow.
- The bot runs as a standalone webhook service.
- Any repository can use it after the GitHub App is installed there.
- In pull request comments, users can trigger it with `/review` or by mentioning the app handle, such as `@your-app-slug review`.

## GitHub App setup

Create a new GitHub App in GitHub settings and configure:

- Homepage URL: your deployed service or project page
- Webhook URL: `https://your-domain.example/github/webhook`
- Webhook secret: generate a random secret and also set it as `GITHUB_WEBHOOK_SECRET`

Repository permissions:

- `Issues`: Read and write
- `Pull requests`: Read and write
- `Metadata`: Read-only

Subscribe to these webhook events:

- `Issue comment`

After the app is created:

1. Download the private key from the GitHub App settings page.
2. Install the app on the repositories you want the bot to support.
3. Set the environment variables below in the deployed service.

## Environment variables

Required:

- `GITHUB_APP_ID`
- `GITHUB_WEBHOOK_SECRET`
- `GITHUB_APP_PRIVATE_KEY` or `GITHUB_APP_PRIVATE_KEY_PATH`
- `OPENAI_API_KEY`

Optional:

- `GITHUB_APP_SLUG`: Used to derive the default mention handle such as `@my-review-bot`
- `REVIEW_BOT_HANDLE`: Overrides the default trigger handle
- `OPENAI_BASE_URL`: Custom OpenAI-compatible endpoint
- `OPENAI_MODEL`: Defaults to `gpt-4.1-mini`
- `REVIEW_MAX_COMMENTS`: Defaults to `8`
- `REVIEW_MAX_FILES`: Defaults to `15`
- `REVIEW_MAX_PATCH_CHARS`: Defaults to `50000`
- `HOST`: Defaults to `0.0.0.0`
- `PORT`: Defaults to `8000`
- `LOG_LEVEL`: Defaults to `INFO`

If you put the private key directly into `GITHUB_APP_PRIVATE_KEY`, escaped newlines are supported.

## Running the service

Install dependencies, then start the webhook server:

```bash
openviking-github-app-review-bot
```

Or with uvicorn:

```bash
uvicorn openviking.tools.github_app_review_bot:create_app --factory --host 0.0.0.0 --port 8000
```

## Usage

Once the app is installed on a repository, comment on a pull request with:

```text
/review
```

```text
/review focus on tests and backwards compatibility
```

```text
@your-app-slug review
```

```text
@your-app-slug review focus on performance and API design
```

## Notes

- The app can only review repositories where it has been installed.
- The service verifies the GitHub webhook signature before processing events.
- Reviews are queued in a FastAPI background task so the webhook can return quickly.
- The bot posts a review summary and tries to attach inline comments to the changed lines in the PR diff.
