# Naver Blog Assistant

Chrome extension (Manifest V3) that helps a reader summarize a Naver Blog post and prepare a thoughtful comment draft.

## Scope

- Extract text from the page currently open in Naver Blog.
- Use OpenAI's Responses API through a local companion service to create editable, context-aware comment drafts.
- Present drafts for the reader to review and copy.
- Keep liking and publishing comments as explicit, manual user actions.

The extension does not automatically browse posts, press Like, submit comments, or include promotional boilerplate.

## OpenAI setup

The API key is intentionally kept out of the extension and repository. OpenAI API keys must not be exposed in browser-side code, so the included local service reads `OPENAI_API_KEY` from its own process environment and listens only on `127.0.0.1`.

1. Create an OpenAI API key in the OpenAI Platform dashboard.
2. In PowerShell, start the local service with the key in the current shell session:

   ```powershell
   $env:OPENAI_API_KEY = "your_api_key"
   python server/app.py
   ```

   To override the default model, set `OPENAI_MODEL` before starting it. The default is `gpt-5-mini`.
3. Keep that PowerShell window open, then load the extension as described below.

Never add an API key to `manifest.json`, JavaScript files, `.env`, or Git.

## Development

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.
4. Open a Naver Blog post, then open the extension popup.

## Structure

- `manifest.json`: extension configuration
- `src/content.js`: extracts readable page text on demand
- `src/popup/`: popup interface and draft generation logic
- `server/app.py`: local OpenAI API proxy; it keeps the API key outside Chrome
