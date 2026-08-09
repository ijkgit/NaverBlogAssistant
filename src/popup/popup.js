const statusElement = document.querySelector('#status');
const draftElement = document.querySelector('#draft');
const createButton = document.querySelector('#create-draft');
const copyButton = document.querySelector('#copy-draft');
const LOCAL_API_URL = 'http://127.0.0.1:8765/draft';

async function requestDrafts(text, title) {
  const response = await fetch(LOCAL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, title })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'AI 초안을 만들지 못했습니다.');
  return payload.drafts;
}

function isNaverBlogUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'blog.naver.com' || hostname === 'm.blog.naver.com';
  } catch {
    return false;
  }
}

async function getPostContent(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['src/content.js']
  });

  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  const results = await Promise.all((frames || []).map(async ({ frameId }) => {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'GET_POST_TEXT' }, { frameId });
    } catch {
      return null;
    }
  }));

  return results
    .filter((result) => result?.text)
    .sort((left, right) => right.text.length - left.text.length)[0];
}

createButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !isNaverBlogUrl(tab.url)) {
    statusElement.textContent = '네이버 블로그 글 페이지에서 실행해 주세요.';
    return;
  }

  statusElement.textContent = '글을 읽는 중입니다…';
  try {
    const result = await getPostContent(tab.id);
    if (!result?.text) throw new Error('본문을 찾지 못했습니다.');

    const drafts = await requestDrafts(result.text, result.title);
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new Error('AI가 사용할 수 있는 초안을 반환하지 않았습니다.');
    }

    draftElement.value = drafts.map((draft, index) => `${index + 1}. ${draft}`).join('\n\n');
    copyButton.disabled = false;
    statusElement.textContent = 'AI 초안을 확인하고 맥락에 맞게 고쳐 주세요.';
  } catch (error) {
    statusElement.textContent = error.message || '본문을 읽거나 AI 초안을 만들지 못했습니다.';
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(draftElement.value);
  statusElement.textContent = '초안을 복사했습니다. 댓글 등록은 직접 진행해 주세요.';
});
