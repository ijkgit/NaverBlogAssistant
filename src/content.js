(() => {
  if (globalThis.naverBlogAssistantContentLoaded) return;
  globalThis.naverBlogAssistantContentLoaded = true;

  const POST_SELECTORS = [
    '.se-main-container',
    '#postViewArea',
    '.post-view',
    'article'
  ];

  const COMMENT_SELECTORS = [
    'textarea.u_cbox_text',
    'textarea.u_cbox_text_guide',
    'textarea[id*="cbox"]',
    'textarea[class*="cbox"]',
    'textarea[placeholder*="댓글"]',
    'textarea[aria-label*="댓글"]',
    'textarea[placeholder*="입력"]',
    '[contenteditable="true"][data-placeholder*="댓글"]',
    '[contenteditable="true"][aria-label*="댓글"]',
    '[contenteditable="true"][role="textbox"]',
    '.u_cbox_write [contenteditable="true"]',
    '.u_cbox_text_wrap [contenteditable="true"]'
  ];

  const OPEN_COMMENT_SELECTORS = [
    '.u_cbox_btn_comment',
    '.u_cbox_btn_write',
    '.u_cbox_write_btn',
    '.lo_txt',
    'a[class*="comment"]',
    'button[class*="comment"]'
  ];

  const SUBMIT_SELECTORS = [
    '.u_cbox_btn_upload',
    'button.u_cbox_btn_upload',
    'a.u_cbox_btn_upload',
    '.u_cbox_write .u_cbox_btn_upload',
    'button[class*="cbox"][class*="upload"]'
  ];


  // Naver Blog LikeIt (current desktop Blog DOM)
  // The actual user-owned reaction module has this structure:
  // .u_likeit_list_module._reactionModule_BLOG[data-catgid="post"]
  //   a.u_likeit_button._face
  //     span.u_likeit_icons
  //       span.u_likeit_icon.__reaction__zeroface
  //
  // The user confirmed that clicking the zeroface span itself immediately
  // applies the default heart reaction. Therefore we NEVER click the
  // surrounding face button first (that can open the reaction picker).
  const LIKE_ICON_SELECTOR =
    'span.u_likeit_icon.__reaction__zeroface';

  const LIKE_MODULE_SELECTOR =
    '.u_likeit_list_module._reactionModule_BLOG[data-catgid="post"]';

  function findDefaultLikeIcon() {
    // Prefer the reaction module belonging to the post itself. Do not use
    // visibility/size checks here: the icon can have no independent layout
    // box while its parent is still the real clickable target.
    const modules = Array.from(
      document.querySelectorAll(LIKE_MODULE_SELECTOR)
    );

    for (const module of modules) {
      const icon = module.querySelector(LIKE_ICON_SELECTOR);
      if (icon) return icon;
    }

    // Fallback for a slightly different Blog DOM that still exposes the
    // same zeroface class.
    return document.querySelector(LIKE_ICON_SELECTOR);
  }

  function getLikeState() {
    const icon = findDefaultLikeIcon();

    // zeroface is the unselected/default-heart state.
    if (icon) return 'off';

    // When zeroface disappears, inspect the user's own reaction module.
    const modules = Array.from(
      document.querySelectorAll(LIKE_MODULE_SELECTOR)
    );

    for (const module of modules) {
      const face = module.querySelector('a.u_likeit_button._face');
      if (
        face?.getAttribute('aria-pressed') === 'true' ||
        face?.classList.contains('on') ||
        face?.classList.contains('selected')
      ) {
        return 'on';
      }

      // Naver can replace zeroface with a concrete reaction icon after
      // selection. Any concrete reaction icon in the user's module means
      // the reaction has already been applied.
      const concrete = module.querySelector(
        '.u_likeit_icons .u_likeit_icon:not(.__reaction__zeroface)'
      );
      if (concrete && !concrete.classList.contains('__reaction__zeroface')) {
        const style = window.getComputedStyle(concrete);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          return 'on';
        }
      }
    }

    return 'missing';
  }

  async function waitForDefaultLikeIcon(timeout = 30000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const icon = findDefaultLikeIcon();
      if (icon) return icon;

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return null;
  }

  function fireDirectClick(element) {
    // Use both the native click and a real mouse-style event. The first is
    // what the user's manual click maps to in the DOM; the second helps when
    // the LikeIt widget has delegated handlers listening for mouse events.
    element.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
    element.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
    element.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    }));
  }

  async function clickLike() {
    // Give LikeIt a moment to initialize, then find it in the DOM without
    // requiring the user to scroll to the bottom first.
    await new Promise((resolve) => setTimeout(resolve, 500));

    let icon = findDefaultLikeIcon();

    // If the post is long, bring the LikeIt area into view after we know it
    // exists. This is much more reliable than checking visibility before
    // scrolling.
    if (icon) {
      icon.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // Trigger lazy rendering and wait again. We deliberately do not click
      // any reaction button here because that could open the picker.
      window.scrollTo({
        top: Math.max(
          document.documentElement.scrollHeight || 0,
          document.body?.scrollHeight || 0
        ),
        behavior: 'smooth'
      });

      icon = await waitForDefaultLikeIcon(30000);
    }

    if (!icon) {
      const state = getLikeState();

      if (state === 'on') {
        return {
          ok: true,
          liked: true,
          alreadyLiked: true,
          reaction: 'like',
          stateConfirmed: true
        };
      }

      return {
        ok: false,
        liked: false,
        error:
          '네이버 블로그의 기본 하트 좋아요 대상인 span.u_likeit_icon.__reaction__zeroface를 찾지 못했습니다. 페이지를 새로고침한 뒤 다시 시도해 주세요.'
      };
    }

    // The user explicitly confirmed this exact element is the direct
    // one-click heart target. Never click its parent face button first.
    icon.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((resolve) => setTimeout(resolve, 400));

    fireDirectClick(icon);

    // Allow Naver's LikeIt handler to update the DOM.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    // Confirm without clicking again. A second click could toggle the heart
    // back off, so once the event has been delivered we stop.
    const confirmStart = Date.now();
    while (Date.now() - confirmStart < 5000) {
      if (!findDefaultLikeIcon()) {
        return {
          ok: true,
          liked: true,
          alreadyLiked: false,
          reaction: 'like',
          stateConfirmed: true
        };
      }

      const state = getLikeState();
      if (state === 'on') {
        return {
          ok: true,
          liked: true,
          alreadyLiked: false,
          reaction: 'like',
          stateConfirmed: true
        };
      }

      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    // The click has already been sent. Do not click again because that could
    // undo the reaction. Report success and let the following comment step
    // continue.
    return {
      ok: true,
      liked: true,
      alreadyLiked: false,
      reaction: 'like',
      stateConfirmed: false
    };
  }

  function getPostText() {
    const element = POST_SELECTORS
      .map((selector) => document.querySelector(selector))
      .find(Boolean);

    return (element?.innerText || document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isVisible(element) {
    if (!element) return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function isEnabled(element) {
    return !element.disabled &&
      element.getAttribute('aria-disabled') !== 'true' &&
      !element.classList.contains('disabled');
  }

  function hasCommentContext(element) {
    const parent = element.closest(
      '[class*="cbox"], [id*="cbox"], [class*="comment"], [id*="comment"]'
    );

    if (parent) return true;

    const text = [
      element.innerText || '',
      element.textContent || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('title') || '',
      element.getAttribute('class') || ''
    ].join(' ');

    return /댓글|comment/i.test(text);
  }

  function findCommentEditor() {
    const preferred = document.querySelectorAll(
      'textarea.u_cbox_text, textarea.u_cbox_text_guide'
    );

    for (const element of preferred) {
      if (isVisible(element)) return element;
    }

    for (const selector of COMMENT_SELECTORS) {
      const elements = Array.from(document.querySelectorAll(selector));
      const candidate = elements.find((element) =>
        isVisible(element) && hasCommentContext(element)
      );
      if (candidate) return candidate;
    }

    const editables = Array.from(
      document.querySelectorAll('textarea, input, [contenteditable="true"]')
    );

    return editables.find((element) =>
      isVisible(element) && hasCommentContext(element)
    ) || null;
  }

  function getElementText(element) {
    return String(
      element.innerText ||
      element.textContent ||
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      ''
    ).replace(/\s+/g, ' ').trim();
  }

  function isCommentOpenControl(element) {
    if (!isVisible(element)) return false;

    const text = getElementText(element);
    const cls = String(element.className || '');
    const aria = String(element.getAttribute('aria-label') || '');
    const title = String(element.getAttribute('title') || '');

    if (/답글|reply/i.test(text)) return false;
    if (/공감|비공감|신고|더보기|좋아요/i.test(text)) return false;

    return (
      /댓글/.test(text) ||
      /댓글/.test(aria) ||
      /댓글/.test(title) ||
      /comment/i.test(cls)
    );
  }

  function findCommentOpenControl() {
    for (const selector of OPEN_COMMENT_SELECTORS) {
      const elements = Array.from(document.querySelectorAll(selector));
      const candidate = elements.find(isCommentOpenControl);
      if (candidate) return candidate;
    }

    // Naver has used .lo_txt for the visible comment toggle in some layouts.
    // Search small clickable elements containing exactly "댓글" so that we
    // don't accidentally click an existing comment or a reply control.
    const candidates = Array.from(
      document.querySelectorAll('a, button, [role="button"], span')
    ).filter((element) => {
      if (!isVisible(element)) return false;
      if (!hasCommentContext(element)) return false;
      const text = getElementText(element);
      if (!text) return false;
      return /^댓글(?:\s*\d+)?$/.test(text) || /^댓글\s*쓰기$/.test(text);
    });

    return candidates.find((element) => {
      const clickable = element.closest('a, button, [role="button"]');
      return clickable && isVisible(clickable) && isEnabled(clickable);
    }) || null;
  }

  async function waitForEditor(timeout = 8000) {
    const start = Date.now();

    while (Date.now() - start < timeout) {
      const editor = findCommentEditor();
      if (editor) return editor;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return null;
  }

  async function openCommentEditor() {
    // First check the current document.
    let editor = findCommentEditor();
    if (editor) return { ok: true, editor, opened: false };

    // Scroll to the bottom in stages. Naver may lazy-render the comment
    // module only when it enters the viewport.
    const maxY = Math.max(
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0
    );

    const steps = Math.max(4, Math.min(12, Math.ceil(maxY / window.innerHeight)));

    for (let i = 1; i <= steps; i++) {
      window.scrollTo({
        top: Math.min(maxY, i * window.innerHeight),
        behavior: 'smooth'
      });
      await new Promise((resolve) => setTimeout(resolve, 250));

      editor = findCommentEditor();
      if (editor) return { ok: true, editor, opened: false };

      const control = findCommentOpenControl();
      if (control) {
        const clickable = control.closest('a, button, [role="button"]') || control;
        if (isVisible(clickable) && isEnabled(clickable)) {
          clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await new Promise((resolve) => setTimeout(resolve, 150));
          clickable.click();
          await new Promise((resolve) => setTimeout(resolve, 500));

          editor = await waitForEditor(5000);
          if (editor) return { ok: true, editor, opened: true };
        }
      }
    }

    // Final direct search after scrolling to the end.
    window.scrollTo({
      top: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight || 0
      ),
      behavior: 'smooth'
    });

    await new Promise((resolve) => setTimeout(resolve, 800));

    editor = findCommentEditor();
    if (editor) return { ok: true, editor, opened: false };

    const control = findCommentOpenControl();
    if (control) {
      const clickable = control.closest('a, button, [role="button"]') || control;
      clickable.click();
      editor = await waitForEditor(6000);
      if (editor) return { ok: true, editor, opened: true };
    }

    return {
      ok: false,
      error: '댓글 영역을 자동으로 열지 못했습니다. 이 네이버 페이지의 댓글 허용 여부나 현재 댓글 UI 구조를 확인해 주세요.'
    };
  }

  function setNativeValue(element, value) {
    const prototype = element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;

    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      'value'
    );

    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setContentEditableValue(element, value) {
    element.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);

    let inserted = false;

    try {
      inserted = document.execCommand('insertText', false, value);
    } catch (_) {
      inserted = false;
    }

    if (!inserted || !element.innerText.includes(value)) {
      element.textContent = value;
    }

    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: value
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function getEditorValue(editor) {
    return 'value' in editor
      ? String(editor.value || '')
      : String(editor.innerText || editor.textContent || '');
  }

  async function insertIntoEditor(comment) {
    const opened = await openCommentEditor();

    if (!opened.ok || !opened.editor) {
      return opened;
    }

    const editor = opened.editor;

    editor.scrollIntoView({
      behavior: 'smooth',
      block: 'center'
    });

    if (editor.matches('textarea, input')) {
      setNativeValue(editor, comment);
    } else if (editor.isContentEditable) {
      setContentEditableValue(editor, comment);
    } else {
      return {
        ok: false,
        error: '댓글 입력창의 입력 방식을 확인하지 못했습니다.'
      };
    }

    editor.focus();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const currentValue = getEditorValue(editor);

    if (!currentValue.includes(comment)) {
      return {
        ok: false,
        error: '댓글 입력창에 내용을 넣지 못했습니다.'
      };
    }

    return {
      ok: true,
      editor,
      opened: opened.opened
    };
  }

  function findSubmitButton() {
    for (const selector of SUBMIT_SELECTORS) {
      const elements = Array.from(document.querySelectorAll(selector));
      const candidate = elements.find((element) =>
        isVisible(element) && isEnabled(element)
      );
      if (candidate) return candidate;
    }

    // Fallback: find a visible clickable element labeled "등록" near the
    // comment editor. Avoid unrelated buttons elsewhere on the page.
    const editors = Array.from(document.querySelectorAll(
      'textarea.u_cbox_text, textarea.u_cbox_text_guide, [contenteditable="true"]'
    )).filter(isVisible);

    for (const editor of editors) {
      const container = editor.closest(
        '.u_cbox_write, .u_cbox_write_wrap, .u_cbox_write_box, [class*="cbox"]'
      );

      if (!container) continue;

      const buttons = Array.from(
        container.querySelectorAll('button, a, [role="button"]')
      );

      const button = buttons.find((element) => {
        if (!isVisible(element) || !isEnabled(element)) return false;
        const text = getElementText(element);
        return /^등록$/.test(text) || /등록/.test(text);
      });

      if (button) return button;
    }

    return null;
  }

  async function submitComment() {
    const start = Date.now();
    let button = null;

    while (Date.now() - start < 8000) {
      button = findSubmitButton();
      if (button) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    if (!button) {
      return {
        ok: false,
        error: '댓글 입력 후 네이버의 등록 버튼을 찾지 못했습니다.'
      };
    }

    button.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    button.click();

    // Wait briefly for Naver to process the submission. We intentionally do
    // not attempt another click to avoid duplicate comments.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    return {
      ok: true,
      submitted: true
    };
  }

  async function insertAndSubmit(comment) {
    const inserted = await insertIntoEditor(comment);

    if (!inserted.ok) return inserted;

    const submitted = await submitComment();

    if (!submitted.ok) return submitted;

    return {
      ok: true,
      opened: Boolean(inserted.opened),
      submitted: true,
      frameUrl: location.href
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'LIKE_POST') {
      clickLike()
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            liked: false,
            error: error?.message || '공감 버튼을 누르는 중 오류가 발생했습니다.'
          });
        });

      return true;
    }

    if (message?.type === 'GET_POST_TEXT') {
      sendResponse({
        title: document.title,
        url: location.href,
        text: getPostText()
      });
      return;
    }

    if (message?.type === 'INSERT_AND_SUBMIT_COMMENT') {
      const comment = String(message.comment || '').trim();

      if (!comment) {
        sendResponse({
          ok: false,
          error: '입력할 댓글이 비어 있습니다.'
        });
        return;
      }

      // Do not return before the async operation finishes.
      insertAndSubmit(comment)
        .then(sendResponse)
        .catch((error) => {
          sendResponse({
            ok: false,
            error: error?.message || '댓글 입력/등록 중 오류가 발생했습니다.'
          });
        });

      return true;
    }
  });
})();
