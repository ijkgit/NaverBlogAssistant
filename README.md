# Naver Blog Assistant

Chrome extension (Manifest V3) that helps a reader summarize a Naver Blog post and prepare a thoughtful comment draft.

## Scope

- Extract text from the page currently open in Naver Blog.
- Use a local Ollama model through a local companion service to create editable, context-aware comment drafts.
- Present drafts for the reader to review and copy.
- Record posts locally only after the reader has manually registered a comment, to flag already-processed posts.
- Keep liking and publishing comments as explicit, manual user actions.

The extension does not automatically browse posts, press Like, submit comments, or include promotional boilerplate.

Processing history is stored in Chrome's local extension storage. It stays on the current browser profile and is not sent to the local service or OpenAI.

## Ollama setup

The extension and companion service run entirely on the local machine. No API key, billing account, or cloud API is required.

1. Install [Ollama](https://ollama.com/download).
2. Download the default model once:

   ```powershell
   ollama pull qwen3:4b
   ```

3. Start the companion service:

   ```powershell
   python server/app.py
   ```

   To use another locally installed model, set `OLLAMA_MODEL` before starting it. The default is `qwen3:4b`.
4. Keep that PowerShell window open, then load the extension as described below.

The companion service calls Ollama at `http://127.0.0.1:11434` by default. Set `OLLAMA_API_URL` only if the Ollama API uses a different local address.

## Development

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.
4. Open a Naver Blog post, then open the extension popup.

## Structure

- `manifest.json`: extension configuration
- `src/content.js`: extracts readable page text on demand
- `src/popup/`: popup interface and draft generation logic
- `server/app.py`: local Ollama proxy; it keeps generation on the current PC
