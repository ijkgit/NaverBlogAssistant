const statusElement = document.querySelector('#status');
const draftElement = document.querySelector('#draft');
const createButton = document.querySelector('#create-draft');
const copyButton = document.querySelector('#copy-draft');
const markCompleteButton = document.querySelector('#mark-complete');
const LOCAL_API_URL = 'http://127.0.0.1:8765/draft';
const PROCESSED_POSTS_KEY = 'processedPosts';
const PENDING_POSTS_KEY = 'pendingPosts';
let currentPost = null;

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

function getPostId(url) {
  const parsed = new URL(url);
  const segments = parsed.pathname.split('/').filter(Boolean);
  const blogId = parsed.searchParams.get('blogId') || segments[0] || '';
  const logNo = parsed.searchParams.get('logNo') || segments.at(-1) || '';
  return blogId && logNo ? `${blogId}/${logNo}` : parsed.origin + parsed.pathname;
}

async function getPostList(key) {
  const value = await chrome.storage.local.get({ [key]: [] });
  return Array.isArray(value[key]) ? value[key] : [];
}

async function savePostList(key, posts) {
  await chrome.storage.local.set({ [key]: posts });
}

function showDraft(draft) {
  draftElement.value = draft;
  copyButton.disabled = false;
  markCompleteButton.disabled = false;
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
  copyButton.disabled = true;
  markCompleteButton.disabled = true;
  try {
    const result = await getPostContent(tab.id);
    if (!result?.text) throw new Error('본문을 찾지 못했습니다.');

    const postUrl = result.url || tab.url;
    currentPost = {
      id: getPostId(postUrl),
      title: result.title || '제목 없음',
      url: postUrl
    };
    const processedPosts = await getPostList(PROCESSED_POSTS_KEY);
    if (processedPosts.some((post) => post.id === currentPost.id)) {
      draftElement.value = '';
      copyButton.disabled = true;
      markCompleteButton.disabled = true;
      statusElement.textContent = '이 글은 이미 댓글 등록 완료로 기록되어 있습니다.';
      return;
    }

    const pendingPosts = await getPostList(PENDING_POSTS_KEY);
    const pendingPost = pendingPosts.find((post) => post.id === currentPost.id);
    if (pendingPost) {
      showDraft(pendingPost.draft);
      statusElement.textContent = '이전에 만든 초안입니다. 댓글 등록 후 완료로 기록해 주세요.';
      return;
    }

    const drafts = await requestDrafts(result.text, result.title);
    if (!Array.isArray(drafts) || drafts.length === 0) {
      throw new Error('AI가 사용할 수 있는 초안을 반환하지 않았습니다.');
    }

    const draft = drafts.map((item, index) => `${index + 1}. ${item}`).join('\n\n');
    currentPost.draft = draft;
    await savePostList(PENDING_POSTS_KEY, [
      ...pendingPosts.filter((post) => post.id !== currentPost.id),
      currentPost
    ]);
    showDraft(draft);
    statusElement.textContent = 'AI 초안을 확인하고 맥락에 맞게 고쳐 주세요.';
  } catch (error) {
    statusElement.textContent = error.message || '본문을 읽거나 AI 초안을 만들지 못했습니다.';
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(draftElement.value);
  statusElement.textContent = '초안을 복사했습니다. 댓글 등록은 직접 진행해 주세요.';
});

draftElement.addEventListener('input', async () => {
  if (!currentPost) return;

  currentPost.draft = draftElement.value;
  const pendingPosts = await getPostList(PENDING_POSTS_KEY);
  await savePostList(PENDING_POSTS_KEY, [
    ...pendingPosts.filter((post) => post.id !== currentPost.id),
    currentPost
  ]);
});

markCompleteButton.addEventListener('click', async () => {
  if (!currentPost) return;

  const processedPosts = await getPostList(PROCESSED_POSTS_KEY);
  const pendingPosts = await getPostList(PENDING_POSTS_KEY);
  const record = {
    id: currentPost.id,
    title: currentPost.title,
    url: currentPost.url,
    completedAt: new Date().toISOString()
  };

  await Promise.all([
    savePostList(PROCESSED_POSTS_KEY, [
      record,
      ...processedPosts.filter((post) => post.id !== record.id)
    ].slice(0, 500)),
    savePostList(PENDING_POSTS_KEY, pendingPosts.filter((post) => post.id !== record.id))
  ]);
  markCompleteButton.disabled = true;
  statusElement.textContent = '이 글을 댓글 등록 완료로 기록했습니다. 다음 글에서 다시 초안을 만들 수 있습니다.';
});
