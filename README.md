# Naver Blog Assistant

Chrome extension (Manifest V3) that helps a reader summarize a Naver Blog post and prepare a thoughtful comment draft.

## Scope

- Extract text from the page currently open in Naver Blog.
- Present a short, editable comment draft for the reader to copy.
- Keep liking and publishing comments as explicit, manual user actions.

The extension does not automatically browse posts, press Like, submit comments, or include promotional boilerplate.

## Development

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode**.
3. Choose **Load unpacked** and select this repository folder.
4. Open a Naver Blog post, then open the extension popup.

## Structure

- `manifest.json`: extension configuration
- `src/content.js`: extracts readable page text on demand
- `src/popup/`: popup interface and draft generation logic

