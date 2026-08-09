(() => {
  if (globalThis.naverBlogAssistantContentLoaded) return;
  globalThis.naverBlogAssistantContentLoaded = true;

  const CONTENT_SELECTORS = [
    '.se-main-container',
    '#postViewArea',
    '.post-view',
    'article'
  ];

  function getPostText() {
    const element = CONTENT_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find(Boolean);

    return (element?.innerText || document.body.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'GET_POST_TEXT') return;

    sendResponse({
      title: document.title,
      text: getPostText()
    });
  });
})();
