(function () {
  const appShell = document.getElementById('app-shell');
  const conversationList = document.getElementById('conversation-list');
  const conversationSearch = document.getElementById('conversation-search');
  const chatInner = document.getElementById('chat-inner');
  const chatScroll = document.getElementById('chat-scroll');
  const emptyState = document.getElementById('empty-state');
  const errorBanner = document.getElementById('error-banner');
  const composerInput = document.getElementById('composer-input');
  const sendBtn = document.getElementById('send-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const modelSelect = document.getElementById('model-select');
  const userAvatar = document.getElementById('user-avatar');
  const userName = document.getElementById('user-name');
  const userDept = document.getElementById('user-dept');
  const workspaceToggleBtn = document.getElementById('workspace-toggle-btn');
  const workspaceMenu = document.getElementById('workspace-menu');
  const workspaceAdminLink = document.getElementById('workspace-admin-link');
  const workspaceInstructionsBtn = document.getElementById('workspace-instructions-btn');
  const workspaceThemeBtn = document.getElementById('workspace-theme-btn');
  AmerbTheme.wireThemeToggle(workspaceThemeBtn);
  const logoutBtn = document.getElementById('logout-btn');
  const attachBtn = document.getElementById('attach-btn');
  const attachMenu = document.getElementById('attach-menu');
  const attachFilesBtn = document.getElementById('attach-files-btn');
  const fileInput = document.getElementById('file-input');
  const attachmentChipsEl = document.getElementById('attachment-chips');
  const previewPanel = document.getElementById('preview-panel');
  const previewIcon = document.getElementById('preview-icon');
  const previewFilename = document.getElementById('preview-filename');
  const previewBody = document.getElementById('preview-body');
  const previewDownloadBtn = document.getElementById('preview-download-btn');
  const previewCloseBtn = document.getElementById('preview-close-btn');
  const webSearchToggleBtn = document.getElementById('web-search-toggle-btn');
  const settingsModalOverlay = document.getElementById('settings-modal-overlay');
  const settingsModalClose = document.getElementById('settings-modal-close');
  const settingsModalCancel = document.getElementById('settings-modal-cancel');
  const settingsModalSave = document.getElementById('settings-modal-save');
  const customInstructionsInput = document.getElementById('custom-instructions-input');
  const workspacePasswordBtn = document.getElementById('workspace-password-btn');
  const passwordModalOverlay = document.getElementById('password-modal-overlay');
  const passwordModalClose = document.getElementById('password-modal-close');
  const passwordModalCancel = document.getElementById('password-modal-cancel');
  const passwordModalSave = document.getElementById('password-modal-save');
  const passwordModalError = document.getElementById('password-modal-error');
  const currentPasswordInput = document.getElementById('current-password-input');
  const newPasswordInput = document.getElementById('new-password-input');
  const confirmPasswordInput = document.getElementById('confirm-password-input');
  const workspaceCompareBtn = document.getElementById('workspace-compare-btn');
  const compareModalOverlay = document.getElementById('compare-modal-overlay');
  const compareModalClose = document.getElementById('compare-modal-close');
  const compareModalCloseBtn = document.getElementById('compare-modal-close-btn');
  const comparePromptInput = document.getElementById('compare-prompt-input');
  const compareModelA = document.getElementById('compare-model-a');
  const compareModelB = document.getElementById('compare-model-b');
  const compareOutputA = document.getElementById('compare-output-a');
  const compareOutputB = document.getElementById('compare-output-b');
  const compareRunBtn = document.getElementById('compare-run-btn');
  const exportBtn = document.getElementById('export-btn');
  const exportMenu = document.getElementById('export-menu');
  const exportDocxBtn = document.getElementById('export-docx-btn');
  const exportPdfBtn = document.getElementById('export-pdf-btn');
  const chatMain = document.getElementById('chat-main');
  const dropOverlay = document.getElementById('drop-overlay');
  const searchAllBtn = document.getElementById('search-all-btn');
  const searchModalOverlay = document.getElementById('search-modal-overlay');
  const searchModalClose = document.getElementById('search-modal-close');
  const searchModalInput = document.getElementById('search-modal-input');
  const searchModalResults = document.getElementById('search-modal-results');
  const workspacePromptsBtn = document.getElementById('workspace-prompts-btn');
  const promptsModalOverlay = document.getElementById('prompts-modal-overlay');
  const promptsModalClose = document.getElementById('prompts-modal-close');
  const promptTitleInput = document.getElementById('prompt-title-input');
  const promptContentInput = document.getElementById('prompt-content-input');
  const promptAddBtn = document.getElementById('prompt-add-btn');
  const savedPromptsList = document.getElementById('saved-prompts-list');
  const micBtn = document.getElementById('mic-btn');
  const mentionMenu = document.getElementById('mention-menu');
  const workspaceHelpBtn = document.getElementById('workspace-help-btn');
  const helpModalOverlay = document.getElementById('help-modal-overlay');
  const helpModalClose = document.getElementById('help-modal-close');
  const DEFAULT_COMPOSER_PLACEHOLDER = composerInput.placeholder;

  const DOC_ICONS = { docx: 'fileText', pdf: 'fileText', xlsx: 'fileSpreadsheet', pptx: 'presentation', text: 'fileText', webpage: 'globe' };
  const DOC_LABELS = {
    docx: 'Word document',
    pdf: 'PDF',
    xlsx: 'Excel spreadsheet',
    pptx: 'PowerPoint presentation',
    text: 'Document',
    webpage: 'Web page',
  };

  const DEPARTMENT_PROMPTS = {
    Credit: [
      'Summarize our credit policy on collateral requirements',
      'Draft a loan approval letter',
      'What is the maximum loan-to-value ratio for a commercial loan?',
    ],
    Loans: [
      'Explain our loan restructuring process',
      'Draft a loan offer letter for a customer',
      'Analyze a loan portfolio spreadsheet I attach',
    ],
    Finance: [
      'Create an Excel reconciliation template',
      "What's today's GHS to USD exchange rate?",
      'Summarize a financial report I attach',
    ],
    Operations: [
      'Draft a standard operating procedure memo',
      'Create a daily branch closing checklist',
      'Summarize our branch operations manual',
    ],
    'Customer Service': [
      'Draft a response to a common customer complaint',
      'Summarize our account-opening FAQ',
      'Write a polite email declining a service request',
    ],
    HR: [
      'Draft a job posting for an open role',
      'Summarize our staff leave policy',
      'Create an offer letter template',
    ],
    IT: [
      'Draft a security awareness reminder for staff',
      'Summarize our password policy',
      'Explain our approved software list',
    ],
    'Compliance & Risk': [
      "Search Bank of Ghana's site for the latest regulatory update",
      'Summarize our AML policy',
      'Draft a compliance checklist',
    ],
    Audit: [
      'Summarize our internal audit checklist',
      'Draft an audit finding memo',
      'What documents are required for a branch audit?',
    ],
    Management: [
      "What's the latest Bank of Ghana policy rate?",
      'Draft a memo to all staff',
      'Summarize a report I attach',
    ],
    General: [
      'Summarize a document I attach',
      'Draft a professional email',
      'Create an Excel spreadsheet from data I give you',
    ],
  };

  function renderStarterPrompts(department) {
    const container = document.getElementById('starter-prompts');
    if (!container) return;
    const prompts = DEPARTMENT_PROMPTS[department] || DEPARTMENT_PROMPTS.General;
    container.innerHTML = '';
    for (const prompt of prompts) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'starter-prompt-chip';
      chip.innerHTML = `${icon('lightbulb', { size: 14 })}<span>${escapeHtml(prompt)}</span>`;
      chip.addEventListener('click', () => {
        if (isStreaming) return;
        composerInput.value = prompt;
        composerInput.dispatchEvent(new Event('input', { bubbles: true }));
        sendMessage();
      });
      container.appendChild(chip);
    }
  }

  let webSearchToggled = false;
  let webSearchAvailable = false;

  // ---------- Preview panel ----------

  async function openPreview(documentId, filename, kind) {
    previewPanel.classList.remove('hidden');
    previewIcon.innerHTML = icon(DOC_ICONS[kind] || 'fileText', { size: 17 });
    previewFilename.textContent = filename;
    previewDownloadBtn.href = `/api/documents/${documentId}/file`;
    previewBody.innerHTML = '<div class="preview-loading">Loading preview...</div>';

    if (kind === 'pdf') {
      previewBody.innerHTML = `<iframe src="/api/documents/${documentId}/file"></iframe>`;
      return;
    }

    try {
      const res = await fetch(`/api/documents/${documentId}/preview`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load preview');
      if (data.type === 'html') {
        previewBody.innerHTML = `<div class="preview-html">${data.html}</div>`;
      } else {
        previewBody.innerHTML = `<div class="preview-text">${escapeHtml(data.text)}</div>`;
      }
    } catch (err) {
      previewBody.innerHTML = `<div class="preview-loading">${escapeHtml(err.message)}</div>`;
    }
  }

  function closePreview() {
    previewPanel.classList.add('hidden');
    previewBody.innerHTML = '';
  }

  previewCloseBtn.addEventListener('click', closePreview);

  let currentConversationId = null;
  let conversations = [];
  let isStreaming = false;
  let currentAbortController = null;
  let pendingAttachments = []; // { id, filename, kind, status: 'uploading' | 'ready' | 'error' }
  let modelsByName = new Map(); // name -> { vision, tools }

  function showBanner(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove('hidden');
  }

  function hideBanner() {
    errorBanner.classList.add('hidden');
  }

  // ---------- Bootstrap ----------

  async function bootstrap() {
    const sessionRes = await fetch('/api/session');
    const sessionData = await sessionRes.json();
    if (!sessionData.authenticated) {
      window.location.href = '/login.html';
      return;
    }

    appShell.classList.remove('hidden');

    const meRes = await fetch('/api/auth/me');
    const meData = await meRes.json();
    userName.textContent = meData.user.username;
    userDept.textContent = meData.user.department || '';
    userAvatar.textContent = meData.user.username.slice(0, 1).toUpperCase();
    customInstructionsInput.value = meData.user.customInstructions || '';
    if (meData.user.role === 'admin') {
      workspaceAdminLink.classList.remove('hidden');
    }
    renderStarterPrompts(meData.user.department);

    await loadModels();
    await loadConversations();
    await loadSettings();
    maybeShowOnboarding(meData.user.username);
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      webSearchAvailable = Boolean(data.webSearchEnabled);
    } catch {
      webSearchAvailable = false;
    }
    webSearchToggleBtn.disabled = !webSearchAvailable;
    webSearchToggleBtn.title = webSearchAvailable
      ? 'Search the web for this message'
      : 'Web search is disabled — ask an admin to enable it in the admin portal';
  }

  async function loadModels() {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load models');

      modelSelect.innerHTML = '';
      modelsByName = new Map();
      if (!data.models.length) {
        const opt = document.createElement('option');
        opt.textContent = 'No models found — run "ollama pull <model>"';
        opt.disabled = true;
        modelSelect.appendChild(opt);
        return;
      }
      for (const m of data.models) {
        modelsByName.set(m.name, m);
        const opt = document.createElement('option');
        opt.value = m.name;
        const tags = [m.vision ? '👁' : '', m.tools ? '🔧' : '', m.thinking ? '🧠' : ''].filter(Boolean).join(' ');
        opt.textContent = tags ? `${m.name} ${tags}` : m.name;
        modelSelect.appendChild(opt);
      }
    } catch (err) {
      showBanner(err.message);
    }
  }

  async function loadConversations() {
    const res = await fetch('/api/conversations');
    const data = await res.json();
    conversations = data.conversations || [];
    renderConversationList();
  }

  function renderConversationList() {
    conversationList.innerHTML = '';
    const query = conversationSearch.value.trim().toLowerCase();
    const filtered = query ? conversations.filter((c) => c.title.toLowerCase().includes(query)) : conversations;

    if (query && !filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'conversation-search-empty';
      empty.textContent = 'No matching chats';
      conversationList.appendChild(empty);
      return;
    }

    for (const convo of filtered) {
      const item = document.createElement('div');
      item.className = 'conversation-item' + (convo.id === currentConversationId ? ' active' : '');

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = convo.title;
      item.appendChild(title);

      const delBtn = document.createElement('button');
      delBtn.className = 'delete-btn';
      delBtn.innerHTML = icon('x', { size: 12 });
      delBtn.title = 'Delete conversation';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteConversation(convo.id);
      });
      item.appendChild(delBtn);

      item.addEventListener('click', () => openConversation(convo.id));
      conversationList.appendChild(item);
    }
  }

  async function deleteConversation(id) {
    if (!confirm('Delete this conversation?')) return;
    await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (currentConversationId === id) {
      startNewChat();
    }
    await loadConversations();
  }

  async function openConversation(id) {
    if (isStreaming) return;
    hideBanner();
    const res = await fetch(`/api/conversations/${id}`);
    if (!res.ok) {
      await loadConversations();
      return;
    }
    const data = await res.json();
    currentConversationId = id;
    if (data.conversation.model) {
      modelSelect.value = data.conversation.model;
    }
    renderMessages(data.messages);
    renderConversationList();
  }

  function startNewChat() {
    currentConversationId = null;
    chatInner.innerHTML = '';
    chatInner.appendChild(emptyState);
    emptyState.classList.remove('hidden');
    renderConversationList();
    composerInput.focus();
  }

  // ---------- Message rendering ----------

  function renderMessages(messages) {
    chatInner.innerHTML = '';
    if (!messages.length) {
      chatInner.appendChild(emptyState);
      return;
    }
    for (const m of messages) {
      appendMessageRow(
        m.role, m.content, m.attachments || [], m.id, m.citations || [], m.thinking || '', m.feedback || null,
        m.versionIndex, m.versionTotal
      );
    }
    scrollToBottom();
  }

  function appendMessageRow(role, content, attachments, messageId, citations, thinking, feedback, versionIndex, versionTotal) {
    if (emptyState.parentElement) emptyState.remove();

    const row = document.createElement('div');
    row.className = `message-row ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    if (role === 'user') {
      avatar.textContent = 'You';
    } else {
      const img = document.createElement('img');
      img.src = '/img/favicon.png';
      img.alt = 'AMERB AI';
      avatar.appendChild(img);
    }
    row.appendChild(avatar);

    const contentEl = document.createElement('div');
    contentEl.className = 'message-content';

    if (role === 'assistant' && attachments && attachments.length) {
      // Assistant-side attachments are generated files — images show full-size, documents show
      // a clickable card that opens the preview panel.
      for (const att of attachments) {
        if (!att.id) continue;
        if (att.kind === 'image') {
          const img = document.createElement('img');
          img.className = 'generated-image';
          img.src = `/api/documents/${att.id}/image`;
          img.alt = att.filename;
          contentEl.appendChild(img);
        } else {
          const card = document.createElement('div');
          card.className = 'doc-card';
          card.innerHTML = `
            <span class="doc-icon">${icon(DOC_ICONS[att.kind] || 'fileText', { size: 20 })}</span>
            <div>
              <div class="doc-name">${escapeHtml(att.filename)}</div>
              <div class="doc-hint">${DOC_LABELS[att.kind] || 'Document'} · Click to preview</div>
            </div>
          `;
          card.addEventListener('click', () => openPreview(att.id, att.filename, att.kind));
          contentEl.appendChild(card);
        }
      }
    } else if (attachments && attachments.length) {
      const attWrap = document.createElement('div');
      attWrap.className = 'message-attachments';
      for (const att of attachments) {
        const chip = document.createElement('div');
        chip.className = 'chip';
        const iconHtml = att.kind === 'image' && att.id
          ? `<img class="chip-thumb" src="/api/documents/${att.id}/image" alt="">`
          : icon('paperclip', { size: 14 });
        chip.innerHTML = `${iconHtml}<span class="chip-name">${escapeHtml(att.filename)}</span>`;
        attWrap.appendChild(chip);
      }
      contentEl.appendChild(attWrap);
    }

    let toolStatusEl = null;
    let textEl = null;
    let bubble = null;
    let thinkingEl = null;

    if (role === 'user') {
      bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = content;
      contentEl.appendChild(bubble);
    } else {
      thinkingEl = document.createElement('details');
      thinkingEl.className = 'thinking-block hidden';
      thinkingEl.innerHTML = `<summary>${icon('lightbulb', { size: 14 })} Thought process</summary><div class="thinking-text"></div>`;
      contentEl.appendChild(thinkingEl);
      if (thinking) {
        thinkingEl.classList.remove('hidden');
        thinkingEl.querySelector('.thinking-text').textContent = thinking;
      }

      toolStatusEl = document.createElement('div');
      toolStatusEl.className = 'tool-status hidden';
      contentEl.appendChild(toolStatusEl);

      textEl = document.createElement('div');
      setMarkdownContent(textEl, content);
      contentEl.appendChild(textEl);

      if (citations && citations.length) {
        contentEl.appendChild(makeCitationsEl(citations));
      }
    }

    if (messageId) row.dataset.messageId = messageId;

    const actions = document.createElement('div');
    actions.className = 'message-actions';
    let versionSwitcherEl = null;
    if (role === 'assistant') {
      versionSwitcherEl = document.createElement('span');
      versionSwitcherEl.className = 'version-switcher hidden';
      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'version-switcher-btn';
      prevBtn.innerHTML = icon('chevronLeft', { size: 12 });
      prevBtn.title = 'Previous version';
      const label = document.createElement('span');
      label.className = 'version-label';
      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'version-switcher-btn';
      nextBtn.innerHTML = icon('chevronRight', { size: 12 });
      nextBtn.title = 'Next version';
      prevBtn.addEventListener('click', () => switchVersion(row, versionSwitcherEl, textEl, thinkingEl, -1));
      nextBtn.addEventListener('click', () => switchVersion(row, versionSwitcherEl, textEl, thinkingEl, 1));
      versionSwitcherEl.append(prevBtn, label, nextBtn);
      actions.appendChild(versionSwitcherEl);
      updateVersionSwitcher(versionSwitcherEl, versionIndex || 1, versionTotal || 1);

      actions.appendChild(makeActionBtn(icon('copy', { size: 14 }), 'Copy', () => copyMessageText(textEl, actions)));
      const speakBtn = makeActionBtn(icon('volume', { size: 14 }), 'Read aloud', () => toggleSpeak(speakBtn, textEl));
      actions.appendChild(speakBtn);
      const upBtn = makeActionBtn(icon('thumbsUp', { size: 14 }), 'Good response', () => sendFeedback(row, 'up', upBtn, downBtn));
      const downBtn = makeActionBtn(icon('thumbsDown', { size: 14 }), 'Bad response', () => sendFeedback(row, 'down', upBtn, downBtn));
      upBtn.classList.add('feedback-up');
      downBtn.classList.add('feedback-down');
      if (feedback === 'up') upBtn.classList.add('active');
      if (feedback === 'down') downBtn.classList.add('active');
      actions.appendChild(upBtn);
      actions.appendChild(downBtn);
    }
    if (role === 'user') {
      actions.appendChild(makeActionBtn(icon('pencil', { size: 14 }), 'Edit', () => startEditMessage(row, bubble)));
    } else {
      actions.appendChild(makeActionBtn(icon('refresh', { size: 14 }), 'Retry', () => retryMessage(row)));
    }
    actions.appendChild(makeActionBtn(icon('trash', { size: 14 }), 'Delete', () => deleteMessageRow(row)));
    contentEl.appendChild(actions);

    row.appendChild(contentEl);
    chatInner.appendChild(row);
    return { row, contentEl, textEl, toolStatusEl, bubble, thinkingEl, versionSwitcherEl };
  }

  function makeActionBtn(iconHtml, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'message-action-btn';
    btn.type = 'button';
    btn.title = title;
    btn.innerHTML = iconHtml;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function setMarkdownContent(el, text) {
    el.innerHTML = window.renderMarkdown(text);
    el.querySelectorAll('pre').forEach((pre) => {
      if (pre.querySelector('.code-copy-btn')) return;
      pre.style.position = 'relative';
      const btn = document.createElement('button');
      btn.className = 'code-copy-btn';
      btn.type = 'button';
      btn.title = 'Copy code';
      btn.innerHTML = icon('copy', { size: 13 });
      btn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(pre.querySelector('code')?.textContent || pre.textContent);
          const original = btn.innerHTML;
          btn.innerHTML = icon('check', { size: 13 });
          setTimeout(() => {
            btn.innerHTML = original;
          }, 1200);
        } catch {
          showBanner('Could not copy — your browser may be blocking clipboard access.');
        }
      });
      pre.appendChild(btn);
    });
  }

  function makeCitationsEl(citations) {
    const wrap = document.createElement('div');
    wrap.className = 'citations';
    const label = document.createElement('span');
    label.className = 'citations-label';
    label.innerHTML = `${icon('book', { size: 13 })} Sources:`;
    wrap.appendChild(label);
    for (const c of citations) {
      const chip = document.createElement('span');
      chip.className = 'citation-chip';
      chip.textContent = c.filename;
      if (c.id) {
        chip.title = 'Click to preview';
        chip.addEventListener('click', () => openPreview(c.id, c.filename, c.kind || 'text'));
      }
      wrap.appendChild(chip);
    }
    return wrap;
  }

  async function copyMessageText(textEl, actions) {
    if (!textEl) return;
    try {
      await navigator.clipboard.writeText(textEl.innerText);
      const btn = actions.querySelector('.message-action-btn');
      const original = btn.innerHTML;
      btn.innerHTML = icon('check', { size: 14 });
      setTimeout(() => {
        btn.innerHTML = original;
      }, 1200);
    } catch {
      showBanner('Could not copy — your browser may be blocking clipboard access.');
    }
  }

  // ---------- Read aloud ----------

  let currentSpeakBtn = null;

  function resetSpeakBtn(btn) {
    btn.innerHTML = icon('volume', { size: 14 });
    btn.title = 'Read aloud';
  }

  function toggleSpeak(btn, textEl) {
    if (!window.speechSynthesis) {
      showBanner('Read-aloud is not supported in this browser.');
      return;
    }
    if (currentSpeakBtn === btn) {
      speechSynthesis.cancel();
      resetSpeakBtn(btn);
      currentSpeakBtn = null;
      return;
    }
    speechSynthesis.cancel();
    if (currentSpeakBtn) resetSpeakBtn(currentSpeakBtn);

    const text = textEl?.innerText?.trim();
    if (!text) return;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.onend = () => {
      resetSpeakBtn(btn);
      if (currentSpeakBtn === btn) currentSpeakBtn = null;
    };
    utterance.onerror = utterance.onend;
    btn.innerHTML = icon('square', { size: 12 });
    btn.title = 'Stop reading';
    currentSpeakBtn = btn;
    speechSynthesis.speak(utterance);
  }

  // ---------- Version switcher (regenerated alternates) ----------

  // Keyed by every version's own message id so a lookup works no matter which sibling is
  // currently active; populated lazily the first time a row's switcher is actually used.
  const versionsCache = new Map();

  function updateVersionSwitcher(el, index, total) {
    if (!el) return;
    if (total > 1) {
      el.classList.remove('hidden');
      el.querySelector('.version-label').textContent = `${index}/${total}`;
    } else {
      el.classList.add('hidden');
    }
  }

  async function switchVersion(row, versionSwitcherEl, textEl, thinkingEl, delta) {
    if (isStreaming) return;
    const currentId = row.dataset.messageId;
    if (!currentId) return;

    let versions = versionsCache.get(currentId);
    if (!versions) {
      const res = await fetch(`/api/conversations/${currentConversationId}/messages/${currentId}/versions`);
      if (!res.ok) return;
      const data = await res.json();
      versions = data.versions;
      for (const v of versions) versionsCache.set(String(v.id), versions);
    }

    const currentIndex = versions.findIndex((v) => String(v.id) === String(currentId));
    const newIndex = currentIndex + delta;
    if (newIndex < 0 || newIndex >= versions.length) return;
    const target = versions[newIndex];

    const res = await fetch(`/api/conversations/${currentConversationId}/messages/${target.id}/activate`, {
      method: 'PATCH',
    });
    if (!res.ok) return;

    row.dataset.messageId = target.id;
    setMarkdownContent(textEl, target.content);
    if (thinkingEl) {
      if (target.thinking) {
        thinkingEl.classList.remove('hidden');
        thinkingEl.querySelector('.thinking-text').textContent = target.thinking;
      } else {
        thinkingEl.classList.add('hidden');
      }
    }
    const oldCitations = row.querySelector('.citations');
    if (oldCitations) oldCitations.remove();
    if (target.citations && target.citations.length) {
      textEl.insertAdjacentElement('afterend', makeCitationsEl(target.citations));
    }
    updateVersionSwitcher(versionSwitcherEl, newIndex + 1, versions.length);
  }

  // ---------- Feedback ----------

  async function sendFeedback(row, rating, upBtn, downBtn) {
    const messageId = row.dataset.messageId;
    if (!currentConversationId || !messageId) return;

    const wasActive = (rating === 'up' ? upBtn : downBtn).classList.contains('active');
    upBtn.classList.remove('active');
    downBtn.classList.remove('active');
    if (!wasActive) (rating === 'up' ? upBtn : downBtn).classList.add('active');

    try {
      const res = await fetch(`/api/conversations/${currentConversationId}/messages/${messageId}/feedback`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) throw new Error();
    } catch {
      // best-effort — leave the optimistic UI state as-is rather than bothering the user
    }
  }

  // ---------- Delete / retry / edit ----------

  async function deleteMessageRow(row) {
    if (isStreaming) return;
    if (!confirm('Delete this message?')) return;
    const messageId = row.dataset.messageId;
    if (currentConversationId && messageId) {
      const res = await fetch(`/api/conversations/${currentConversationId}/messages/${messageId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showBanner(data.error || 'Could not delete message');
        return;
      }
    }
    row.remove();
    if (!chatInner.querySelector('.message-row')) {
      chatInner.appendChild(emptyState);
    }
  }

  async function retryMessage(row) {
    if (isStreaming) return;
    if (row !== chatInner.lastElementChild) {
      showBanner('Only the most recent reply can be retried.');
      return;
    }
    const messageId = row.dataset.messageId;
    if (!messageId) {
      showBanner('This message cannot be retried yet — please wait for it to finish.');
      return;
    }
    // The regenerated reply is kept alongside this one (switchable via the version arrows), not
    // deleted, so retrying only needs to remove the old row from view — the server supersedes it.
    const model = modelSelect.value;
    row.remove();
    await streamAssistant('/api/chat/regenerate', { conversationId: currentConversationId, model });
  }

  function startEditMessage(row, bubble) {
    if (isStreaming) return;
    const actions = row.querySelector('.message-actions');
    const originalText = bubble.textContent;

    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    textarea.value = originalText;
    bubble.replaceWith(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    actions.classList.add('hidden');

    const editActions = document.createElement('div');
    editActions.className = 'edit-actions';
    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-save-btn';
    saveBtn.textContent = 'Save & submit';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    editActions.append(saveBtn, cancelBtn);
    textarea.insertAdjacentElement('afterend', editActions);

    function cancel() {
      textarea.replaceWith(bubble);
      editActions.remove();
      actions.classList.remove('hidden');
    }

    cancelBtn.addEventListener('click', cancel);

    saveBtn.addEventListener('click', async () => {
      const newContent = textarea.value.trim();
      if (!newContent) return;
      const messageId = row.dataset.messageId;
      if (!messageId) {
        showBanner('Please wait for this message to finish sending before editing it.');
        return;
      }

      const res = await fetch(`/api/conversations/${currentConversationId}/messages/${messageId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: newContent }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        showBanner(data.error || 'Could not save edit');
        return;
      }

      bubble.textContent = newContent;
      textarea.replaceWith(bubble);
      editActions.remove();
      actions.classList.remove('hidden');

      let sibling = row.nextElementSibling;
      while (sibling) {
        const toRemove = sibling;
        sibling = sibling.nextElementSibling;
        toRemove.remove();
      }

      const model = modelSelect.value;
      await streamAssistant('/api/chat/regenerate', { conversationId: currentConversationId, model });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function scrollToBottom() {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }

  // ---------- Attachments ----------

  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!attachMenu.contains(e.target) && e.target !== attachBtn) {
      attachMenu.classList.add('hidden');
    }
  });

  attachFilesBtn.addEventListener('click', () => {
    attachMenu.classList.add('hidden');
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      uploadFiles(Array.from(fileInput.files));
    }
    fileInput.value = '';
  });

  // Drag-and-drop: a nested-element-safe show/hide using an enter/leave counter, since dragging
  // over a child element fires dragleave on the parent even though the pointer is still inside it.
  let dragDepth = 0;

  chatMain.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragDepth += 1;
    dropOverlay.classList.remove('hidden');
  });

  chatMain.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
  });

  chatMain.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add('hidden');
  });

  chatMain.addEventListener('drop', (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add('hidden');
    uploadFiles(Array.from(e.dataTransfer.files));
  });

  // Paste an image (e.g. a screenshot) straight into the composer, the same way ChatGPT/Claude do.
  composerInput.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  });

  // ---------- Workspace menu (knowledge base / admin portal / custom instructions) ----------

  workspaceToggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    workspaceMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!workspaceMenu.contains(e.target) && e.target !== workspaceToggleBtn && !workspaceToggleBtn.contains(e.target)) {
      workspaceMenu.classList.add('hidden');
    }
  });

  // ---------- Custom instructions ----------

  workspaceInstructionsBtn.addEventListener('click', () => {
    workspaceMenu.classList.add('hidden');
    settingsModalOverlay.classList.remove('hidden');
    customInstructionsInput.focus();
  });

  function closeSettingsModal() {
    settingsModalOverlay.classList.add('hidden');
  }

  settingsModalClose.addEventListener('click', closeSettingsModal);
  settingsModalCancel.addEventListener('click', closeSettingsModal);
  settingsModalOverlay.addEventListener('click', (e) => {
    if (e.target === settingsModalOverlay) closeSettingsModal();
  });

  settingsModalSave.addEventListener('click', async () => {
    settingsModalSave.disabled = true;
    try {
      const res = await fetch('/api/auth/me/instructions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ customInstructions: customInstructionsInput.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save');
      customInstructionsInput.value = data.user.customInstructions || '';
      closeSettingsModal();
    } catch (err) {
      showBanner(err.message || 'Could not save custom instructions');
    } finally {
      settingsModalSave.disabled = false;
    }
  });

  // ---------- Change password ----------

  workspacePasswordBtn.addEventListener('click', () => {
    workspaceMenu.classList.add('hidden');
    passwordModalError.classList.add('hidden');
    currentPasswordInput.value = '';
    newPasswordInput.value = '';
    confirmPasswordInput.value = '';
    passwordModalOverlay.classList.remove('hidden');
    currentPasswordInput.focus();
  });

  function closePasswordModal() {
    passwordModalOverlay.classList.add('hidden');
  }

  passwordModalClose.addEventListener('click', closePasswordModal);
  passwordModalCancel.addEventListener('click', closePasswordModal);
  passwordModalOverlay.addEventListener('click', (e) => {
    if (e.target === passwordModalOverlay) closePasswordModal();
  });

  passwordModalSave.addEventListener('click', async () => {
    passwordModalError.classList.add('hidden');

    const currentPassword = currentPasswordInput.value;
    const newPassword = newPasswordInput.value;
    const confirmPassword = confirmPasswordInput.value;

    if (!currentPassword || !newPassword) {
      passwordModalError.textContent = 'Fill in both your current and new password.';
      passwordModalError.classList.remove('hidden');
      return;
    }
    if (newPassword.length < 8) {
      passwordModalError.textContent = 'New password must be at least 8 characters.';
      passwordModalError.classList.remove('hidden');
      return;
    }
    if (newPassword !== confirmPassword) {
      passwordModalError.textContent = 'New password and confirmation do not match.';
      passwordModalError.classList.remove('hidden');
      return;
    }

    passwordModalSave.disabled = true;
    try {
      const res = await fetch('/api/auth/me/password', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not change password');
      closePasswordModal();
    } catch (err) {
      passwordModalError.textContent = err.message || 'Could not change password';
      passwordModalError.classList.remove('hidden');
    } finally {
      passwordModalSave.disabled = false;
    }
  });

  // ---------- Compare models ----------

  workspaceCompareBtn.addEventListener('click', () => {
    workspaceMenu.classList.add('hidden');
    populateCompareModelSelects();
    comparePromptInput.value = '';
    for (const el of [compareOutputA, compareOutputB]) {
      el.textContent = 'Response will appear here.';
      el.classList.add('compare-placeholder');
    }
    compareModalOverlay.classList.remove('hidden');
    comparePromptInput.focus();
  });

  function populateCompareModelSelects() {
    const names = [...modelsByName.keys()];
    for (const select of [compareModelA, compareModelB]) {
      const previous = select.value;
      select.innerHTML = '';
      for (const name of names) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      }
      if (names.includes(previous)) select.value = previous;
    }
    // Default to two different models when there are at least two, so the comparison is useful
    // out of the box instead of comparing a model against itself.
    if (names.length > 1 && compareModelA.value === compareModelB.value) {
      compareModelB.value = names.find((n) => n !== compareModelA.value) || names[0];
    }
  }

  function closeCompareModal() {
    compareModalOverlay.classList.add('hidden');
  }

  compareModalClose.addEventListener('click', closeCompareModal);
  compareModalCloseBtn.addEventListener('click', closeCompareModal);
  compareModalOverlay.addEventListener('click', (e) => {
    if (e.target === compareModalOverlay) closeCompareModal();
  });

  async function runQuickCompletion(model, prompt, outputEl) {
    outputEl.textContent = '';
    outputEl.classList.remove('compare-placeholder');
    try {
      const res = await fetch('/api/chat/quick', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, prompt }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          let eventName = 'message';
          let dataLine = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) dataLine = line.slice(5).trim();
          }
          if (!dataLine) continue;
          const data = JSON.parse(dataLine);

          if (eventName === 'token') {
            accumulated += data.delta;
            outputEl.textContent = accumulated;
          } else if (eventName === 'error') {
            outputEl.textContent = `Error: ${data.error}`;
          }
        }
      }
    } catch (err) {
      outputEl.textContent = `Error: ${err.message || 'Request failed'}`;
    }
  }

  compareRunBtn.addEventListener('click', () => {
    const prompt = comparePromptInput.value.trim();
    if (!prompt) return;
    compareRunBtn.disabled = true;
    Promise.all([
      runQuickCompletion(compareModelA.value, prompt, compareOutputA),
      runQuickCompletion(compareModelB.value, prompt, compareOutputB),
    ]).finally(() => {
      compareRunBtn.disabled = false;
    });
  });

  // ---------- Getting-started help ----------

  function openHelpModal() {
    workspaceMenu.classList.add('hidden');
    helpModalOverlay.classList.remove('hidden');
  }

  function closeHelpModal() {
    helpModalOverlay.classList.add('hidden');
  }

  workspaceHelpBtn.addEventListener('click', openHelpModal);
  helpModalClose.addEventListener('click', closeHelpModal);
  helpModalOverlay.addEventListener('click', (e) => {
    if (e.target === helpModalOverlay) closeHelpModal();
  });

  // Shown once per staff account (keyed by username, not a single blanket flag) — several staff
  // often share one branch/front-desk PC, so a single browser-wide flag would only ever show this
  // to whoever happened to log into that machine first, never to anyone else's actual first login.
  // Called from bootstrap() below, after auth is confirmed, so it never appears on the login page.
  function maybeShowOnboarding(username) {
    try {
      const key = `amerb-onboarding-seen-${username}`;
      if (!localStorage.getItem(key)) {
        openHelpModal();
        localStorage.setItem(key, '1');
      }
    } catch {
      /* localStorage unavailable (e.g. private browsing) — skip auto-show, not worth failing over */
    }
  }

  // ---------- Full-text search across all chats ----------

  let searchDebounceTimer = null;

  function openSearchModal() {
    workspaceMenu.classList.add('hidden');
    searchModalOverlay.classList.remove('hidden');
    searchModalInput.value = '';
    searchModalResults.innerHTML = '';
    searchModalInput.focus();
  }

  function closeSearchModal() {
    searchModalOverlay.classList.add('hidden');
  }

  async function runChatSearch(query) {
    if (!query) {
      searchModalResults.innerHTML = '';
      return;
    }
    const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    searchModalResults.innerHTML = '';
    if (!res.ok) {
      searchModalResults.innerHTML = `<div class="search-empty">${escapeHtml(data.error || 'Search failed')}</div>`;
      return;
    }
    if (!data.results.length) {
      searchModalResults.innerHTML = '<div class="search-empty">No matches in any of your chats.</div>';
      return;
    }
    for (const r of data.results) {
      const item = document.createElement('div');
      item.className = 'search-result-item';
      item.innerHTML = `
        <div>
          <div class="search-result-title">${escapeHtml(r.title)}</div>
          <div class="search-result-snippet">${escapeHtml(r.snippet)}</div>
        </div>
      `;
      item.addEventListener('click', () => {
        closeSearchModal();
        openConversation(r.conversationId);
      });
      searchModalResults.appendChild(item);
    }
  }

  searchAllBtn.addEventListener('click', openSearchModal);
  searchModalClose.addEventListener('click', closeSearchModal);
  searchModalOverlay.addEventListener('click', (e) => {
    if (e.target === searchModalOverlay) closeSearchModal();
  });
  searchModalInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    const query = searchModalInput.value.trim();
    searchDebounceTimer = setTimeout(() => runChatSearch(query), 250);
  });

  // ---------- Saved prompts ----------

  async function loadSavedPrompts() {
    const res = await fetch('/api/prompts');
    const data = await res.json();
    savedPromptsList.innerHTML = '';
    if (!data.prompts || !data.prompts.length) {
      savedPromptsList.innerHTML = '<div class="prompts-empty">No saved prompts yet — add one above.</div>';
      return;
    }
    for (const p of data.prompts) {
      const item = document.createElement('div');
      item.className = 'saved-prompt-item';
      item.innerHTML = `
        <div>
          <div class="saved-prompt-title">${escapeHtml(p.title)}</div>
          <div class="saved-prompt-snippet">${escapeHtml(p.content.slice(0, 100))}${p.content.length > 100 ? '…' : ''}</div>
        </div>
      `;
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'chip-remove';
      deleteBtn.innerHTML = icon('x', { size: 12 });
      deleteBtn.title = 'Delete prompt';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/prompts/${p.id}`, { method: 'DELETE' });
        loadSavedPrompts();
      });
      item.appendChild(deleteBtn);
      item.addEventListener('click', () => {
        composerInput.value = composerInput.value ? `${composerInput.value}\n${p.content}` : p.content;
        composerInput.dispatchEvent(new Event('input'));
        closePromptsModal();
        composerInput.focus();
      });
      savedPromptsList.appendChild(item);
    }
  }

  function openPromptsModal() {
    workspaceMenu.classList.add('hidden');
    promptsModalOverlay.classList.remove('hidden');
    loadSavedPrompts();
  }

  function closePromptsModal() {
    promptsModalOverlay.classList.add('hidden');
  }

  workspacePromptsBtn.addEventListener('click', openPromptsModal);
  promptsModalClose.addEventListener('click', closePromptsModal);
  promptsModalOverlay.addEventListener('click', (e) => {
    if (e.target === promptsModalOverlay) closePromptsModal();
  });
  promptAddBtn.addEventListener('click', async () => {
    const title = promptTitleInput.value.trim();
    const content = promptContentInput.value.trim();
    if (!title || !content) return;
    promptAddBtn.disabled = true;
    try {
      const res = await fetch('/api/prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content }),
      });
      const data = await res.json();
      if (!res.ok) {
        showBanner(data.error || 'Could not save prompt');
        return;
      }
      promptTitleInput.value = '';
      promptContentInput.value = '';
      await loadSavedPrompts();
    } finally {
      promptAddBtn.disabled = false;
    }
  });

  // ---------- Voice input (transcribed locally — nothing leaves this machine) ----------

  let mediaRecorder = null;
  let audioChunks = [];
  let isRecording = false;

  async function resampleTo16kMono(arrayBuffer) {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      const offlineCtx = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
      const source = offlineCtx.createBufferSource();
      source.buffer = decoded;
      source.connect(offlineCtx.destination);
      source.start();
      const rendered = await offlineCtx.startRendering();
      return rendered.getChannelData(0);
    } finally {
      audioCtx.close();
    }
  }

  async function startRecording() {
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      showBanner(
        'Voice input needs a secure context and browser mic support. If this page loads over ' +
          'http:// (not https://) or the address bar shows a certificate warning you haven\'t accepted, ' +
          'the browser blocks microphone access silently — open the app at https://... first.'
      );
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      showBanner(`Could not access the microphone: ${err.message || err.name || 'permission denied'}.`);
      return;
    }
    try {
      audioChunks = [];
      mediaRecorder = new MediaRecorder(stream);
      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.push(e.data);
      };
      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        await handleRecordingComplete();
      };
      mediaRecorder.start();
      isRecording = true;
      micBtn.classList.add('recording');
      micBtn.title = 'Recording — click again to stop and transcribe';
      composerInput.placeholder = 'Recording... click the mic again to stop and transcribe';
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      showBanner(`Could not start recording: ${err.message || 'unknown error'}.`);
    }
  }

  function stopRecording() {
    if (mediaRecorder && isRecording) {
      mediaRecorder.stop();
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.title = 'Voice input (transcribed locally, never leaves this machine)';
    }
  }

  async function handleRecordingComplete() {
    micBtn.disabled = true;
    composerInput.placeholder = 'Transcribing locally...';
    try {
      const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
      const arrayBuffer = await blob.arrayBuffer();
      const samples = await resampleTo16kMono(arrayBuffer);
      const res = await fetch('/api/speech/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: samples.buffer,
      });
      const data = await res.json();
      if (!res.ok) {
        showBanner(data.error || 'Transcription failed');
        return;
      }
      if (data.text) {
        composerInput.value = composerInput.value ? `${composerInput.value} ${data.text}` : data.text;
        composerInput.dispatchEvent(new Event('input'));
        composerInput.focus();
      }
    } catch (err) {
      showBanner(err.message || 'Transcription failed');
    } finally {
      micBtn.disabled = false;
      composerInput.placeholder = DEFAULT_COMPOSER_PLACEHOLDER;
    }
  }

  micBtn.addEventListener('click', () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  });

  // ---------- @-mention a knowledge-base document ----------

  let mentionDocsCache = null;
  let mentionActive = false;
  let mentionStart = -1;

  async function getMentionDocs() {
    if (mentionDocsCache) return mentionDocsCache;
    const res = await fetch('/api/documents');
    const data = await res.json();
    mentionDocsCache = data.documents || [];
    return mentionDocsCache;
  }

  function closeMentionMenu() {
    mentionActive = false;
    mentionStart = -1;
    mentionMenu.classList.add('hidden');
    mentionMenu.innerHTML = '';
  }

  function attachMentionedDocument(doc) {
    if (!pendingAttachments.some((a) => a.id === doc.id)) {
      pendingAttachments.push({ id: doc.id, filename: doc.filename, kind: doc.kind, status: 'ready' });
      renderChips();
    }
  }

  async function updateMentionMenu() {
    const cursor = composerInput.selectionStart;
    const value = composerInput.value;
    const uptoCursor = value.slice(0, cursor);
    const at = uptoCursor.lastIndexOf('@');
    if (at === -1 || /\s/.test(uptoCursor.slice(at + 1)) || (at > 0 && !/\s/.test(uptoCursor[at - 1]))) {
      closeMentionMenu();
      return;
    }
    mentionActive = true;
    mentionStart = at;
    const query = uptoCursor.slice(at + 1).toLowerCase();
    const docs = await getMentionDocs();
    const matches = docs.filter((d) => d.filename.toLowerCase().includes(query)).slice(0, 8);

    mentionMenu.innerHTML = '';
    if (!matches.length) {
      mentionMenu.innerHTML = '<div class="mention-empty">No matching documents</div>';
    } else {
      for (const doc of matches) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = `${icon(DOC_ICONS[doc.kind] || 'fileText', { size: 14 })} <span>${escapeHtml(doc.filename)}</span>`;
        btn.addEventListener('click', () => {
          const before = composerInput.value.slice(0, mentionStart);
          const after = composerInput.value.slice(composerInput.selectionStart);
          composerInput.value = `${before}${after}`;
          composerInput.selectionStart = composerInput.selectionEnd = before.length;
          attachMentionedDocument(doc);
          closeMentionMenu();
          composerInput.dispatchEvent(new Event('input'));
          composerInput.focus();
        });
        mentionMenu.appendChild(btn);
      }
    }
    mentionMenu.classList.remove('hidden');
  }

  composerInput.addEventListener('input', updateMentionMenu);
  composerInput.addEventListener('click', () => {
    if (mentionActive) updateMentionMenu();
  });
  composerInput.addEventListener('blur', () => {
    // Delay so a click on a mention-menu button still registers before the menu disappears.
    setTimeout(() => closeMentionMenu(), 150);
  });

  // ---------- Export conversation ----------

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentConversationId) {
      showBanner('Start a conversation before exporting it.');
      return;
    }
    exportMenu.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!exportMenu.contains(e.target) && e.target !== exportBtn) {
      exportMenu.classList.add('hidden');
    }
  });

  function exportConversation(format) {
    exportMenu.classList.add('hidden');
    if (!currentConversationId) return;
    window.location.href = `/api/conversations/${currentConversationId}/export?format=${format}`;
  }

  exportDocxBtn.addEventListener('click', () => exportConversation('docx'));
  exportPdfBtn.addEventListener('click', () => exportConversation('pdf'));

  function renderChips() {
    if (!pendingAttachments.length) {
      attachmentChipsEl.classList.add('hidden');
      attachmentChipsEl.innerHTML = '';
      return;
    }
    attachmentChipsEl.classList.remove('hidden');
    attachmentChipsEl.innerHTML = '';
    for (const att of pendingAttachments) {
      const chip = document.createElement('div');
      chip.className = 'chip' + (att.status === 'uploading' ? ' uploading' : '');
      let iconHtml = icon('paperclip', { size: 14 });
      if (att.status === 'error') iconHtml = icon('alertTriangle', { size: 14 });
      else if (att.kind === 'image' && att.id) iconHtml = `<img class="chip-thumb" src="/api/documents/${att.id}/image" alt="">`;
      chip.innerHTML = `${iconHtml}<span class="chip-name">${escapeHtml(att.filename)}</span>`;

      const removeBtn = document.createElement('button');
      removeBtn.className = 'chip-remove';
      removeBtn.innerHTML = icon('x', { size: 11 });
      removeBtn.title = 'Remove';
      removeBtn.addEventListener('click', () => {
        pendingAttachments = pendingAttachments.filter((a) => a !== att);
        renderChips();
      });
      chip.appendChild(removeBtn);

      attachmentChipsEl.appendChild(chip);
    }
  }

  async function uploadFiles(files) {
    const placeholders = files.map((f) => ({ filename: f.name, status: 'uploading' }));
    pendingAttachments.push(...placeholders);
    renderChips();

    const formData = new FormData();
    for (const f of files) formData.append('files', f);

    try {
      const res = await fetch('/api/documents', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      data.results.forEach((result, idx) => {
        const placeholder = placeholders[idx];
        if (result.error) {
          placeholder.status = 'error';
          placeholder.filename = `${result.filename}: ${result.error}`;
        } else {
          placeholder.id = result.id;
          placeholder.filename = result.filename;
          placeholder.kind = result.kind;
          placeholder.status = 'ready';

          if (result.kind === 'image') {
            const model = modelsByName.get(modelSelect.value);
            if (model && !model.vision) {
              showBanner(
                `"${modelSelect.value}" can't see images directly — pull a vision model (e.g. llava, llama3.2-vision, moondream) from the admin portal to have it read this picture. Any text found by OCR will still be searchable.`
              );
            }
          }
        }
      });
    } catch (err) {
      for (const p of placeholders) {
        p.status = 'error';
      }
      showBanner(err.message || 'Upload failed');
    }
    renderChips();
  }

  // ---------- Composer ----------

  composerInput.addEventListener('input', () => {
    composerInput.style.height = 'auto';
    composerInput.style.height = Math.min(composerInput.scrollHeight, 200) + 'px';
    if (!isStreaming) sendBtn.disabled = !composerInput.value.trim();
  });

  composerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'ArrowUp' && !composerInput.value && !isStreaming) {
      e.preventDefault();
      editLastUserMessage();
    }
  });

  function editLastUserMessage() {
    const userRows = chatInner.querySelectorAll('.message-row.user');
    const lastRow = userRows[userRows.length - 1];
    if (!lastRow) return;
    const bubble = lastRow.querySelector('.bubble');
    if (bubble) startEditMessage(lastRow, bubble);
  }

  // ---------- Keyboard shortcuts ----------

  document.addEventListener('keydown', (e) => {
    const isCtrlOrCmd = e.ctrlKey || e.metaKey;
    if (isCtrlOrCmd && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!isStreaming) startNewChat();
      return;
    }
    if (e.key === 'Escape') {
      if (!settingsModalOverlay.classList.contains('hidden')) {
        closeSettingsModal();
      } else if (!passwordModalOverlay.classList.contains('hidden')) {
        closePasswordModal();
      } else if (!compareModalOverlay.classList.contains('hidden')) {
        closeCompareModal();
      } else if (!helpModalOverlay.classList.contains('hidden')) {
        closeHelpModal();
      } else if (!searchModalOverlay.classList.contains('hidden')) {
        closeSearchModal();
      } else if (!promptsModalOverlay.classList.contains('hidden')) {
        closePromptsModal();
      } else if (!mentionMenu.classList.contains('hidden')) {
        closeMentionMenu();
      } else if (!previewPanel.classList.contains('hidden')) {
        closePreview();
      } else if (!workspaceMenu.classList.contains('hidden')) {
        workspaceMenu.classList.add('hidden');
      } else if (!exportMenu.classList.contains('hidden')) {
        exportMenu.classList.add('hidden');
      } else if (!attachMenu.classList.contains('hidden')) {
        attachMenu.classList.add('hidden');
      } else if (isStreaming) {
        currentAbortController?.abort();
      }
    }
  });

  sendBtn.addEventListener('click', () => {
    if (isStreaming) {
      currentAbortController?.abort();
    } else {
      sendMessage();
    }
  });
  newChatBtn.addEventListener('click', () => {
    if (!isStreaming) startNewChat();
  });

  conversationSearch.addEventListener('input', renderConversationList);

  webSearchToggleBtn.addEventListener('click', () => {
    webSearchToggled = !webSearchToggled;
    webSearchToggleBtn.classList.toggle('active', webSearchToggled);
  });

  async function sendMessage() {
    const content = composerInput.value.trim();
    if (!content || isStreaming) return;
    const model = modelSelect.value;
    if (!model) {
      showBanner('No model selected. Pull a model with "ollama pull <model>" first.');
      return;
    }
    if (pendingAttachments.some((a) => a.status === 'uploading')) {
      showBanner('Please wait for attachments to finish uploading.');
      return;
    }

    const readyAttachments = pendingAttachments.filter((a) => a.status === 'ready');
    const documentIds = readyAttachments.map((a) => a.id);
    const forceWebSearch = webSearchToggled;

    hideBanner();
    composerInput.value = '';
    composerInput.style.height = 'auto';
    isStreaming = true;
    sendBtn.disabled = true;

    const { row: userRow } = appendMessageRow(
      'user',
      content,
      readyAttachments.map((a) => ({ id: a.id, filename: a.filename, kind: a.kind }))
    );
    pendingAttachments = [];
    renderChips();
    webSearchToggled = false;
    webSearchToggleBtn.classList.remove('active');

    await streamAssistant(
      '/api/chat/stream',
      { conversationId: currentConversationId, model, content, documentIds, forceWebSearch },
      userRow
    );
  }

  const TOOL_LABELS = {
    run_code: 'Calculating',
    fetch_url: 'Fetching a web page',
    web_search: 'Searching the web',
    generate_image: 'Generating an image (can take up to a minute on CPU)',
    create_word_document: 'Writing the Word document',
    create_pdf_document: 'Writing the PDF',
    create_excel_document: 'Building the spreadsheet',
    create_powerpoint: 'Building the presentation',
  };

  // Shared by a plain new message, a retry, and a post-edit resubmit — streams the assistant's
  // reply from either /api/chat/stream or /api/chat/regenerate into a freshly appended row.
  // `userRow`, when provided, gets tagged with its DB id once the server reports it (only relevant
  // for a brand-new message — retries/edits already know their user message's id).
  async function streamAssistant(url, body, userRow) {
    const model = modelSelect.value;
    isStreaming = true;
    sendBtn.disabled = false;
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = icon('square', { size: 14 });
    hideBanner();

    const { contentEl: assistantWrapEl, textEl: assistantContentEl, toolStatusEl, thinkingEl, row: assistantRow, versionSwitcherEl } =
      appendMessageRow('assistant', '');
    assistantContentEl.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
    scrollToBottom();

    let accumulated = '';
    let thinkingAccumulated = '';
    let firstToken = true;
    let firstThinkingToken = true;
    let pendingCitations = [];

    currentAbortController = new AbortController();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: currentAbortController.signal,
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';

        for (const block of blocks) {
          let eventName = 'message';
          let dataLine = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice(6).trim();
            if (line.startsWith('data:')) dataLine = line.slice(5).trim();
          }
          if (!dataLine) continue;
          const data = JSON.parse(dataLine);

          if (eventName === 'meta') {
            if (!currentConversationId) {
              currentConversationId = data.conversationId;
              conversations.unshift({
                id: data.conversationId,
                title: data.title,
                updated_at: new Date().toISOString(),
              });
              renderConversationList();
            }
            if (userRow && data.userMessageId) {
              userRow.dataset.messageId = data.userMessageId;
            }
            if (data.imagesAttachedButUnsupported) {
              showBanner(`"${model}" can't see images directly, but any OCR'd text from the attachment is still available to it.`);
            }
            pendingCitations = data.citations || [];
          } else if (eventName === 'thinking') {
            if (firstThinkingToken) {
              thinkingEl.classList.remove('hidden');
              firstThinkingToken = false;
            }
            thinkingAccumulated += data.delta;
            thinkingEl.querySelector('.thinking-text').textContent = thinkingAccumulated;
            scrollToBottom();
          } else if (eventName === 'tool') {
            const label = TOOL_LABELS[data.name] || data.name;
            toolStatusEl.classList.remove('hidden');
            toolStatusEl.classList.toggle('done', data.status === 'done');
            toolStatusEl.innerHTML = data.status === 'done'
              ? `${icon('check', { size: 13 })} ${escapeHtml(label)} done`
              : `<span class="typing-dot"></span> ${escapeHtml(label)}...`;
          } else if (eventName === 'image') {
            const img = document.createElement('img');
            img.className = 'generated-image';
            img.src = `/api/documents/${data.documentId}/image`;
            img.alt = data.filename;
            assistantWrapEl.insertBefore(img, assistantContentEl);
            scrollToBottom();
          } else if (eventName === 'document') {
            const card = document.createElement('div');
            card.className = 'doc-card';
            card.innerHTML = `
              <span class="doc-icon">${icon(DOC_ICONS[data.kind] || 'fileText', { size: 20 })}</span>
              <div>
                <div class="doc-name">${escapeHtml(data.filename)}</div>
                <div class="doc-hint">${DOC_LABELS[data.kind] || 'Document'} · Click to preview</div>
              </div>
            `;
            card.addEventListener('click', () => openPreview(data.documentId, data.filename, data.kind));
            assistantWrapEl.insertBefore(card, assistantContentEl);
            scrollToBottom();
            openPreview(data.documentId, data.filename, data.kind);
          } else if (eventName === 'token') {
            if (firstToken) {
              assistantContentEl.innerHTML = '';
              firstToken = false;
            }
            accumulated += data.delta;
            setMarkdownContent(assistantContentEl, accumulated);
            scrollToBottom();
          } else if (eventName === 'replace') {
            // A corrective retry ran after the fact (the model refused, then a forced search
            // found real results) — swap the displayed reply for the corrected one.
            accumulated = data.content;
            setMarkdownContent(assistantContentEl, accumulated);
            scrollToBottom();
          } else if (eventName === 'error') {
            showBanner(data.error);
          } else if (eventName === 'done') {
            if (data.messageId) assistantRow.dataset.messageId = data.messageId;
            if (pendingCitations.length) {
              assistantContentEl.insertAdjacentElement('afterend', makeCitationsEl(pendingCitations));
            }
            if (data.versionInfo) {
              updateVersionSwitcher(versionSwitcherEl, data.versionInfo.index, data.versionInfo.total);
            }
          } else if (eventName === 'title') {
            const convo = conversations.find((c) => c.id === data.conversationId);
            if (convo) {
              convo.title = data.title;
              renderConversationList();
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') {
        showBanner(err.message || 'Something went wrong talking to the model.');
      }
      if (assistantContentEl.querySelector('.typing-dot')) {
        if (accumulated) {
          setMarkdownContent(assistantContentEl, accumulated);
        } else if (err.name === 'AbortError') {
          assistantContentEl.innerHTML = '<em class="stopped-note">Generation stopped.</em>';
        }
      }
    } finally {
      isStreaming = false;
      currentAbortController = null;
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = icon('send', { size: 17 });
      sendBtn.disabled = !composerInput.value.trim();
      await loadConversations();
      renderConversationList();
    }
  }

  // ---------- Logout ----------

  logoutBtn.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  bootstrap();
})();
