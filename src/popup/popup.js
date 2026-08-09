const likeButton = document.querySelector('#like-post');
const statusElement = document.querySelector('#status');
const createButton = document.querySelector('#create-draft');
const markCompleteButton = document.querySelector('#mark-complete');
const likeAndCommentButton = document.querySelector('#like-and-comment');

const LOCAL_API_URL = 'http://127.0.0.1:8765/draft';
const PROCESSED_POSTS_KEY = 'processedPosts';
const PENDING_POSTS_KEY = 'pendingPosts';

let currentPost = null;

function stripListPrefix(value) {
  let text = String(value || '').trim();

  // Remove any accidental model/UI list prefix.
  text = text.replace(/^\s*\d+\s*[.)]\s*/gm, '');
  text = text.replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩]\s*/gm, '');
  text = text.replace(/^\s*[-*]\s+/gm, '');

  return text.trim();
}

async function requestDrafts(text, title) {
  const response = await fetch(LOCAL_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, title })
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || 'AI 댓글을 만들지 못했습니다.');
  }

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

  return blogId && logNo
    ? `${blogId}/${logNo}`
    : parsed.origin + parsed.pathname;
}

async function getPostList(key) {
  const value = await chrome.storage.local.get({ [key]: [] });
  return Array.isArray(value[key]) ? value[key] : [];
}

async function savePostList(key, posts) {
  await chrome.storage.local.set({ [key]: posts });
}

async function getFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return frames?.length ? frames : [{ frameId: 0, url: '' }];
  } catch {
    return [{ frameId: 0, url: '' }];
  }
}

async function getPostContent(tabId) {
  const frames = await getFrames(tabId);

  const results = await Promise.all(
    frames.map(async ({ frameId }) => {
      try {
        return await chrome.tabs.sendMessage(
          tabId,
          { type: 'GET_POST_TEXT' },
          { frameId }
        );
      } catch {
        return null;
      }
    })
  );

  return results
    .filter((result) => result?.text)
    .sort((left, right) => right.text.length - left.text.length)[0];
}

async function insertCommentIntoPage(tabId, comment) {
  const cleanComment = stripListPrefix(comment);
  const frames = await getFrames(tabId);

  // Main page first: it can scroll the article and click the comment toggle,
  // which is necessary when Naver has not rendered the CBox yet.
  const orderedFrames = [
    ...frames.filter((frame) => frame.frameId === 0),
    ...frames.filter((frame) => frame.frameId !== 0)
  ];

  for (const { frameId } of orderedFrames) {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        {
          type: 'INSERT_AND_SUBMIT_COMMENT',
          comment: cleanComment
        },
        { frameId }
      );

      if (result?.ok) return result;
    } catch {
      // Try the next frame.
    }
  }

  // The comment frame can be created after the page reacts to the first
  // attempt. Re-scan frames once and try again, but never submit twice from
  // the same successful response.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const retryFrames = await getFrames(tabId);
  const retryOrdered = [
    ...retryFrames.filter((frame) => frame.frameId === 0),
    ...retryFrames.filter((frame) => frame.frameId !== 0)
  ];

  for (const { frameId } of retryOrdered) {
    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        {
          type: 'INSERT_AND_SUBMIT_COMMENT',
          comment: cleanComment
        },
        { frameId }
      );

      if (result?.ok) return result;
    } catch {
      // Continue.
    }
  }

  throw new Error(
    '네이버 댓글 영역을 자동으로 열고 입력/등록하지 못했습니다. 댓글이 허용된 글인지 확인해 주세요.'
  );
}

async function rememberPendingPost(post) {
  const pendingPosts = await getPostList(PENDING_POSTS_KEY);

  await savePostList(PENDING_POSTS_KEY, [
    ...pendingPosts.filter((item) => item.id !== post.id),
    post
  ]);
}

async function removePendingPost(postId) {
  const pendingPosts = await getPostList(PENDING_POSTS_KEY);

  await savePostList(
    PENDING_POSTS_KEY,
    pendingPosts.filter((post) => post.id !== postId)
  );
}


async function ensureContentScript(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['src/content.js']
    });
    return true;
  } catch {
    return false;
  }
}

async function sendLikeToPage(tabId) {
  const frames = await getFrames(tabId);

  const orderedFrames = [
    ...frames.filter((frame) => frame.frameId === 0),
    ...frames.filter((frame) => frame.frameId !== 0)
  ];

  let lastError = '';

  for (const { frameId } of orderedFrames) {
    await ensureContentScript(tabId, frameId);

    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: 'LIKE_POST' },
        { frameId }
      );

      if (result?.ok) return result;
      if (result?.error) lastError = result.error;
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const retryFrames = await getFrames(tabId);

  for (const { frameId } of retryFrames) {
    await ensureContentScript(tabId, frameId);

    try {
      const result = await chrome.tabs.sendMessage(
        tabId,
        { type: 'LIKE_POST' },
        { frameId }
      );

      if (result?.ok) return result;
      if (result?.error) lastError = result.error;
    } catch (error) {
      lastError = error?.message || lastError;
    }
  }

  throw new Error(
    lastError ||
    '네이버 블로그 글의 좋아요(공감) 버튼을 찾지 못했습니다.'
  );
}


async function createAndSubmitComment(tabId) {
  const result=await getPostContent(tabId);
  if(!result?.text) throw new Error('본문을 찾지 못했습니다. 네이버 블로그 글 페이지를 새로고침해 주세요.');
  const tab=await chrome.tabs.get(tabId); const postUrl=result.url||tab.url;
  currentPost={id:getPostId(postUrl),title:result.title||'제목 없음',url:postUrl};
  const processed=await getPostList(PROCESSED_POSTS_KEY);
  if(processed.some(p=>p.id===currentPost.id)) throw new Error('이 글은 이미 댓글 등록 완료로 기록되어 있습니다.');
  const pending=await getPostList(PENDING_POSTS_KEY); const pendingPost=pending.find(p=>p.id===currentPost.id);
  let comment;
  if(pendingPost?.draft) comment=stripListPrefix(pendingPost.draft);
  else { statusElement.textContent='AI가 댓글을 만드는 중입니다…'; const drafts=await requestDrafts(result.text,result.title); if(!Array.isArray(drafts)||!drafts[0]?.trim()) throw new Error('AI가 사용할 수 있는 댓글을 반환하지 않았습니다.'); comment=stripListPrefix(String(drafts[0])); currentPost.draft=comment; await rememberPendingPost(currentPost); }
  statusElement.textContent='댓글 영역을 열고 입력/등록하는 중입니다…';
  const inserted=await insertCommentIntoPage(tabId,comment); if(!inserted?.ok) throw new Error(inserted?.error||'댓글 입력/등록에 실패했습니다.');
  const after=await getPostList(PROCESSED_POSTS_KEY); await savePostList(PROCESSED_POSTS_KEY,[{id:currentPost.id,title:currentPost.title,url:currentPost.url,completedAt:new Date().toISOString()},...after.filter(p=>p.id!==currentPost.id)].slice(0,500));
  await removePendingPost(currentPost.id);
}

likeAndCommentButton.addEventListener('click',async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id||!isNaverBlogUrl(tab.url)){statusElement.textContent='네이버 블로그 글 페이지에서 실행해 주세요.';return;}
  likeAndCommentButton.disabled=true; likeButton.disabled=true; createButton.disabled=true; markCompleteButton.disabled=true;
  try{
    statusElement.textContent='기본 좋아요(하트)를 누르는 중입니다…';
    const likeResult=await sendLikeToPage(tab.id); if(!likeResult?.ok) throw new Error(likeResult?.error||'좋아요(하트)를 누르지 못했습니다.');
    statusElement.textContent=likeResult.alreadyLiked?'이미 좋아요(하트)가 눌려 있습니다. 댓글을 작성하는 중입니다…':'좋아요(하트)를 눌렀습니다. 댓글을 작성하는 중입니다…';
    await createAndSubmitComment(tab.id);
    statusElement.textContent='좋아요(하트) → AI 댓글 작성 → 댓글 등록까지 완료했습니다.';
  }catch(error){statusElement.textContent=error?.message||'좋아요 또는 댓글 작업 중 오류가 발생했습니다.';}
  finally{likeAndCommentButton.disabled=false;likeButton.disabled=false;createButton.disabled=false;}
});

likeButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !isNaverBlogUrl(tab.url)) {
    statusElement.textContent =
      '네이버 블로그 글 페이지에서 실행해 주세요.';
    return;
  }

  likeButton.disabled = true;
  createButton.disabled = true;
  markCompleteButton.disabled = true;
  statusElement.textContent = '좋아요 버튼을 찾는 중입니다…';

  try {
    const result = await sendLikeToPage(tab.id);

    if (!result?.ok) {
      throw new Error(
        result?.error ||
        '좋아요 버튼을 누르지 못했습니다.'
      );
    }

    if (result.alreadyLiked) {
      statusElement.textContent =
        '이미 좋아요(공감)가 눌려 있는 글입니다.';
    } else if (result.stateConfirmed === false) {
      statusElement.textContent =
        '좋아요(공감) 버튼을 눌렀습니다.';
    } else {
      statusElement.textContent =
        '좋아요(공감)를 눌렀습니다.';
    }
  } catch (error) {
    statusElement.textContent =
      error?.message ||
      '좋아요 버튼을 누르지 못했습니다.';
  } finally {
    likeButton.disabled = false;
    createButton.disabled = false;
  }
});

createButton.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });

  if (!tab?.id || !isNaverBlogUrl(tab.url)) {
    statusElement.textContent = '네이버 블로그 글 페이지에서 실행해 주세요.';
    return;
  }

  createButton.disabled = true;
  markCompleteButton.disabled = true;
  statusElement.textContent = '글을 읽는 중입니다…';

  try {
    const result = await getPostContent(tab.id);

    if (!result?.text) {
      throw new Error('본문을 찾지 못했습니다. 네이버 블로그 글 페이지를 새로고침해 주세요.');
    }

    const postUrl = result.url || tab.url;

    currentPost = {
      id: getPostId(postUrl),
      title: result.title || '제목 없음',
      url: postUrl
    };

    const processedPosts = await getPostList(PROCESSED_POSTS_KEY);

    if (processedPosts.some((post) => post.id === currentPost.id)) {
      statusElement.textContent = '이 글은 이미 댓글 등록 완료로 기록되어 있습니다.';
      createButton.disabled = false;
      return;
    }

    const pendingPosts = await getPostList(PENDING_POSTS_KEY);
    const pendingPost = pendingPosts.find((post) => post.id === currentPost.id);

    let comment;

    if (pendingPost?.draft) {
      comment = stripListPrefix(pendingPost.draft);
      statusElement.textContent = '기존 댓글을 실제 댓글 입력창에 넣는 중입니다…';
    } else {
      statusElement.textContent = 'AI가 댓글을 만드는 중입니다…';

      const drafts = await requestDrafts(result.text, result.title);

      if (!Array.isArray(drafts) || drafts.length === 0 || !String(drafts[0]).trim()) {
        throw new Error('AI가 사용할 수 있는 댓글을 반환하지 않았습니다.');
      }

      // 반드시 첫 번째 댓글 하나만 사용하고, 번호는 절대 추가하지 않습니다.
      comment = stripListPrefix(String(drafts[0]));

      currentPost.draft = comment;
      await rememberPendingPost(currentPost);
    }

    statusElement.textContent = '댓글 영역을 열고 입력/등록하는 중입니다…';

    const inserted = await insertCommentIntoPage(tab.id, comment);

    if (!inserted?.ok) {
      throw new Error(inserted?.error || '댓글 입력창에 넣지 못했습니다.');
    }

    currentPost.draft = comment;

    const processedPostsAfterSubmit = await getPostList(PROCESSED_POSTS_KEY);
    await savePostList(PROCESSED_POSTS_KEY, [
      {
        id: currentPost.id,
        title: currentPost.title,
        url: currentPost.url,
        completedAt: new Date().toISOString()
      },
      ...processedPostsAfterSubmit.filter(
        (post) => post.id !== currentPost.id
      )
    ].slice(0, 500));

    await removePendingPost(currentPost.id);

    markCompleteButton.disabled = true;
    createButton.disabled = false;
    statusElement.textContent = '댓글 영역을 열고 댓글 입력 및 등록까지 완료했습니다.';
  } catch (error) {
    createButton.disabled = false;
    statusElement.textContent = error?.message || '댓글을 만들거나 입력창에 넣지 못했습니다.';
  }
});

markCompleteButton.addEventListener('click', async () => {
  if (!currentPost) return;

  const processedPosts = await getPostList(PROCESSED_POSTS_KEY);

  const record = {
    id: currentPost.id,
    title: currentPost.title,
    url: currentPost.url,
    completedAt: new Date().toISOString()
  };

  await savePostList(PROCESSED_POSTS_KEY, [
    record,
    ...processedPosts.filter((post) => post.id !== record.id)
  ].slice(0, 500));

  await removePendingPost(currentPost.id);

  markCompleteButton.disabled = true;
  statusElement.textContent = '이 글을 댓글 등록 완료로 기록했습니다.';
});
