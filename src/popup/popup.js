const statusElement = document.querySelector('#status');
const draftElement = document.querySelector('#draft');
const createButton = document.querySelector('#create-draft');
const copyButton = document.querySelector('#copy-draft');

function buildDraft(text) {
  const excerpt = text.slice(0, 100).replace(/\s+/g, ' ').trim();
  return `글 잘 읽었습니다. ${excerpt ? `특히 “${excerpt}” 부분이 인상 깊었어요. ` : ''}공유해 주신 내용 덕분에 생각해 볼 계기가 되었습니다.`;
}

createButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id || !tab.url?.includes('blog.naver.com')) {
    statusElement.textContent = '네이버 블로그 글 페이지에서 실행해 주세요.';
    return;
  }

  statusElement.textContent = '글을 읽는 중입니다…';
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_POST_TEXT' });
    if (!result?.text) throw new Error('본문을 찾지 못했습니다.');

    draftElement.value = buildDraft(result.text);
    copyButton.disabled = false;
    statusElement.textContent = '초안을 확인하고 필요한 내용을 고쳐 주세요.';
  } catch (error) {
    statusElement.textContent = error.message || '본문을 읽지 못했습니다.';
  }
});

copyButton.addEventListener('click', async () => {
  await navigator.clipboard.writeText(draftElement.value);
  statusElement.textContent = '초안을 복사했습니다. 댓글 등록은 직접 진행해 주세요.';
});
