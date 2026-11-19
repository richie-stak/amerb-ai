(function () {
  AmerbTheme.wireThemeToggle(document.getElementById('theme-toggle-btn'));

  const adminShell = document.getElementById('admin-shell');
  const adminError = document.getElementById('admin-error');
  const tabs = document.querySelectorAll('.admin-tab');
  const panels = {
    users: document.getElementById('panel-users'),
    models: document.getElementById('panel-models'),
    providers: document.getElementById('panel-providers'),
    documents: document.getElementById('panel-documents'),
    tools: document.getElementById('panel-tools'),
    language: document.getElementById('panel-language'),
    analytics: document.getElementById('panel-analytics'),
    operations: document.getElementById('panel-operations'),
    routing: document.getElementById('panel-routing'),
    system: document.getElementById('panel-system'),
    audit: document.getElementById('panel-audit'),
  };

  let departments = [];

  // The three roles in the system and how they are shown to an administrator.
  const ROLE_OPTIONS = [
    ['user', 'Staff'],
    ['admin', 'Administrator'],
    ['auditor', 'Auditor'],
  ];

  function showError(msg) {
    adminError.textContent = msg;
    adminError.classList.remove('hidden');
  }

  function hideError() {
    adminError.classList.add('hidden');
  }

  function formatBytes(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  // A consistent "nothing here yet" row shared by every table on this page, instead of each one
  // improvising its own (previously only the domains table had one, as a one-off inline style).
  function renderEmptyRow(tbody, colSpan, message) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = colSpan;
    td.className = 'admin-table-empty';
    td.innerHTML = `${icon('inbox', { size: 22 })}<span>${message}</span>`;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // ---------- Read-only (auditor) mode ----------
  //
  // The auditor role may see every record and report but change nothing. The server refuses every
  // mutation for that role; this is the second line so the page never offers a control that can only
  // fail. Only GET-only filter controls stay usable (the role is allowed to read language, audit and
  // analytics data). Most admin tables are rendered after the tab opens, so a MutationObserver keeps
  // any newly created control locked as well.
  let isAuditor = false;

  const READONLY_KEEP_IDS = new Set([
    'language-from',
    'language-to',
    'language-filter-language',
    'language-filter-provider',
    'language-filter-model',
    'language-stats-apply',
    'language-stats-clear',
    // Reading terminology: the language choice and the search only fetch (GET), so an auditor may
    // still use them. Adding, editing, approving and deleting stay locked.
    'terms-language-select',
    'terms-search',
    'audit-user',
    'audit-action',
    'audit-from',
    'audit-to',
    'audit-search-btn',
  ]);

  function lockReadonlyControls(root) {
    if (!root) return;
    const controls = [];
    if (root.matches && root.matches('button, input, select, textarea')) controls.push(root);
    controls.push(...root.querySelectorAll('button, input, select, textarea'));
    for (const el of controls) {
      if (READONLY_KEEP_IDS.has(el.id)) continue;
      if (el.closest('[data-readonly-keep]')) continue;
      if (el.disabled) continue;
      el.disabled = true;
      el.setAttribute('aria-disabled', 'true');
      el.classList.add('control-readonly-disabled');
      const toggleRow = el.closest('.settings-toggle-row');
      if (toggleRow) toggleRow.classList.add('is-readonly');
    }
  }

  // The tabs an auditor may read data from. The other tabs stay visible (so the portal's shape is
  // understandable and nothing looks broken by being missing), but their data requests are refused by
  // the server for this role, so say that plainly instead of showing an empty table as if there were
  // no records.
  const AUDITOR_READABLE_TABS = ['language', 'audit', 'analytics'];

  function showAuditorTabNote(name) {
    const panel = panels[name];
    if (!panel || panel.querySelector('.auditor-tab-note')) return;
    const note = document.createElement('p');
    note.className = 'admin-panel-hint hint-tight auditor-tab-note';
    note.textContent =
      'Read-only access: this section’s records are not available to the auditor role. Language, Analytics and the Audit log can be reviewed.';
    const heading = panel.querySelector('h2');
    if (heading) heading.insertAdjacentElement('afterend', note);
    else panel.insertBefore(note, panel.firstChild);
  }

  function applyAuditorMode() {
    const banner = document.getElementById('admin-readonly-banner');
    if (banner) banner.classList.remove('hidden');
    const content = document.querySelector('.admin-content');
    if (!content) return;

    lockReadonlyControls(content);
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        lockReadonlyControls(content);
      });
    });
    observer.observe(content, { childList: true, subtree: true });

    // Defence in depth: refuse mutations here as well. A stale control, or one added by a future
    // render path, must not send a request that the server would reject anyway.
    const nativeFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : input && input.url ? input.url : '';
      const method = String((init && init.method) || 'GET').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD' && url.startsWith('/api/admin')) {
        showError('Read-only access — you can see records and reports but not change anything.');
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'Read-only access' }), {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          })
        );
      }
      return nativeFetch(input, init);
    };
  }

  // ---------- Bootstrap ----------

  async function bootstrap() {
    const sessionRes = await fetch('/api/session');
    const sessionData = await sessionRes.json();
    if (!sessionData.authenticated) {
      window.location.href = '/login.html';
      return;
    }

    const meRes = await fetch('/api/auth/me');
    const meData = await meRes.json();
    const role = meData.user?.role;
    if (!meRes.ok || (role !== 'admin' && role !== 'auditor')) {
      window.location.href = '/';
      return;
    }
    isAuditor = role === 'auditor';

    adminShell.classList.remove('hidden');

    for (const tab of tabs) {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    }

    if (isAuditor) {
      // An auditor may read language/audit/analytics data only. Loading the writable tabs here would
      // just produce refusals, so only the Language tab is fetched up front (the other two load when
      // opened); every mutation control is locked by applyAuditorMode.
      applyAuditorMode();
      showAuditorTabNote('users');
      await loadLanguageTab();
      return;
    }

    // loadSettings() restores the saved house-model base-model selection, which requires the
    // base-model <select> to already be populated — so loadModels() must finish first.
    await loadModels();
    await Promise.all([loadUsers(), loadDocuments(), loadDomains(), loadSettings(), loadProviders()]);
  }

  function selectTab(name) {
    for (const tab of tabs) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    }
    for (const [key, el] of Object.entries(panels)) {
      el.classList.toggle('hidden', key !== name);
    }
    // The auditor role is only allowed to read language, audit and analytics data. The other tabs
    // stay open and say why their data is not shown; firing their requests would only show a refusal.
    if (isAuditor && !AUDITOR_READABLE_TABS.includes(name)) {
      showAuditorTabNote(name);
      if (name !== 'operations') stopOperations();
      return;
    }
    if (name === 'analytics') loadAnalytics();
    if (name === 'audit') loadAudit();
    if (name === 'language') loadLanguageTab();
    if (name === 'operations') startOperations();
    else stopOperations();
    if (name === 'routing') loadRouting();
  }

  // ---------- Audit log ----------

  const AUDIT_LABELS = {
    'auth.login': 'Signed in',
    'auth.login_failed': 'Failed sign-in',
    'auth.account_locked': 'Account locked',
    'auth.logout': 'Signed out',
    'auth.signup': 'Created account',
    'auth.password_changed': 'Changed own password',
    'chat.message': 'Asked a question',
    'document.upload': 'Uploaded documents',
    'document.delete': 'Deleted a document',
    'document.share': 'Shared a document',
    'admin.post': 'Admin change',
    'admin.patch': 'Admin change',
    'admin.put': 'Admin change',
    'admin.delete': 'Admin deletion',
  };

  // One readable line per entry — the full details are still in the CSV export.
  function auditSummary(row) {
    const d = row.details || {};
    switch (row.action) {
      case 'chat.message':
        return `${d.external ? '☁ ' : ''}${d.model}: "${d.question}"${d.attachments?.length ? ` · files: ${d.attachments.join(', ')}` : ''}`;
      case 'auth.login_failed':
        return [d.reason, d.identifier ? `as "${d.identifier}"` : '', d.failedAttempts ? `attempt ${d.failedAttempts}` : ''].filter(Boolean).join(' · ');
      case 'auth.account_locked':
        return `after ${d.failedAttempts} failed attempts`;
      case 'document.upload':
        return `${d.scope === 'global' ? 'Bank-wide' : d.scope === 'personal' ? 'My files' : `${d.department} department`}: ${(d.files || []).join(', ')}`;
      case 'document.delete':
        return `${d.filename} (${d.scope === 'global' ? 'bank-wide' : d.scope === 'personal' ? 'personal' : d.department})`;
      case 'document.share':
        return `${d.filename}: ${d.from} → ${d.to === 'global' ? 'bank-wide' : d.department}`;
      default:
        if (row.action.startsWith('admin.')) {
          const body = d.body && Object.keys(d.body).length ? ` ${JSON.stringify(d.body)}` : '';
          return `${row.action.slice(6).toUpperCase()} ${d.path}${body}`;
        }
        return Object.keys(d).length ? JSON.stringify(d) : '';
    }
  }

  function auditQuery() {
    const params = new URLSearchParams();
    const add = (key, id) => {
      const value = document.getElementById(id).value.trim();
      if (value) params.set(key, value);
    };
    add('user', 'audit-user');
    add('action', 'audit-action');
    add('from', 'audit-from');
    add('to', 'audit-to');
    return params;
  }

  async function loadAudit() {
    const params = auditQuery();
    document.getElementById('audit-export-btn').href = `/api/admin/audit/export.csv?${params}`;
    params.set('limit', '300');
    const res = await fetch(`/api/admin/audit?${params}`);
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load the audit log');

    const tbody = document.getElementById('audit-tbody');
    tbody.innerHTML = '';
    document.getElementById('audit-count').textContent =
      data.total > data.rows.length ? `Showing the latest ${data.rows.length} of ${data.total} entries — export to CSV for all of them.` : `${data.total} entries`;
    if (!data.rows.length) return renderEmptyRow(tbody, 5, 'No activity matches these filters.');

    for (const row of data.rows) {
      const tr = document.createElement('tr');
      const cells = [
        new Date(`${row.at.replace(' ', 'T')}Z`).toLocaleString(),
        row.username ? `${row.username}${row.department ? ` (${row.department})` : ''}` : '—',
        AUDIT_LABELS[row.action] || row.action,
        auditSummary(row),
        row.ip || '',
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      if (row.action === 'auth.login_failed' || row.action === 'auth.account_locked') tr.classList.add('audit-warning');
      tbody.appendChild(tr);
    }
  }

  document.getElementById('audit-search-btn').addEventListener('click', loadAudit);
  document.getElementById('audit-user').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadAudit();
  });

  // ---------- Users ----------

  async function loadUsers() {
    hideError();
    const res = await fetch('/api/admin/users');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load users');
    departments = data.departments;
    renderUsers(data.users);
  }

  function renderUsers(users) {
    const tbody = document.getElementById('users-tbody');
    tbody.innerHTML = '';

    if (!users.length) return renderEmptyRow(tbody, 6, 'No staff accounts yet.');

    for (const u of users) {
      const tr = document.createElement('tr');

      const deptSelect = document.createElement('select');
      const noneOpt = document.createElement('option');
      noneOpt.value = '';
      noneOpt.textContent = '(none)';
      deptSelect.appendChild(noneOpt);
      for (const d of departments) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        if (u.department === d) opt.selected = true;
        deptSelect.appendChild(opt);
      }
      deptSelect.addEventListener('change', async () => {
        const res = await fetch(`/api/admin/users/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ department: deptSelect.value || null }),
        });
        const data = await res.json();
        if (!res.ok) showError(data.error || 'Could not update department');
      });

      // The three roles in the system. Auditors can see the admin portal's records and reports but
      // change nothing; the server enforces that, and the portal locks their controls (see above).
      const roleSelect = document.createElement('select');
      roleSelect.className = 'role-select';
      roleSelect.setAttribute('aria-label', `Role for ${u.username}`);
      for (const [value, label] of ROLE_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        if (u.role === value) opt.selected = true;
        roleSelect.appendChild(opt);
      }
      roleSelect.addEventListener('change', async () => {
        const previous = u.role;
        const newRole = roleSelect.value;
        const res = await fetch(`/api/admin/users/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          // Put the selector back, so the table never claims a change the server refused.
          roleSelect.value = previous;
          return showError(data.error || 'Could not update role');
        }
        // The server may refuse the last remaining administrator, so re-read rather than assume.
        await loadUsers();
      });

      const resetPasswordBtn = document.createElement('button');
      resetPasswordBtn.className = 'table-btn';
      resetPasswordBtn.textContent = 'Reset password';
      resetPasswordBtn.addEventListener('click', async () => {
        if (!confirm(`Reset "${u.username}"'s password? Their current password stops working immediately.`)) return;
        const res = await fetch(`/api/admin/users/${u.id}/reset-password`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Could not reset password');
        showTempPassword(u.username, data.tempPassword);
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'table-btn danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete user "${u.username}"? This removes their conversations and uploads too.`)) return;
        const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Could not delete user');
        await loadUsers();
      });

      const tdUsername = document.createElement('td');
      tdUsername.textContent = u.username;

      const tdEmail = document.createElement('td');
      tdEmail.textContent = u.email;

      const tdDept = document.createElement('td');
      tdDept.appendChild(deptSelect);

      const tdRole = document.createElement('td');
      tdRole.appendChild(roleSelect);

      const tdJoined = document.createElement('td');
      tdJoined.textContent = formatDate(u.created_at);

      const tdActions = document.createElement('td');
      tdActions.appendChild(resetPasswordBtn);
      tdActions.appendChild(deleteBtn);

      tr.append(tdUsername, tdEmail, tdDept, tdRole, tdJoined, tdActions);
      tbody.appendChild(tr);
    }
  }

  // ---------- Reset password ----------

  const resetPasswordModalOverlay = document.getElementById('reset-password-modal-overlay');
  const resetPasswordUsername = document.getElementById('reset-password-username');
  const resetPasswordValue = document.getElementById('reset-password-value');
  const resetPasswordCopyBtn = document.getElementById('reset-password-copy-btn');

  function showTempPassword(username, tempPassword) {
    resetPasswordUsername.textContent = username;
    resetPasswordValue.value = tempPassword;
    resetPasswordModalOverlay.classList.remove('hidden');
  }

  function closeResetPasswordModal() {
    resetPasswordModalOverlay.classList.add('hidden');
    resetPasswordValue.value = '';
  }

  document.getElementById('reset-password-modal-close').addEventListener('click', closeResetPasswordModal);
  document.getElementById('reset-password-modal-done').addEventListener('click', closeResetPasswordModal);
  resetPasswordModalOverlay.addEventListener('click', (e) => {
    if (e.target === resetPasswordModalOverlay) closeResetPasswordModal();
  });

  resetPasswordCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(resetPasswordValue.value);
      const original = resetPasswordCopyBtn.innerHTML;
      resetPasswordCopyBtn.innerHTML = `${icon('check', { size: 14 })} Copied`;
      setTimeout(() => {
        resetPasswordCopyBtn.innerHTML = original;
      }, 1500);
    } catch {
      resetPasswordValue.select();
    }
  });

  // ---------- Models ----------

  async function loadModels() {
    const res = await fetch('/api/admin/models');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load models');
    renderModels(data.models);
    populateHouseModelBaseSelect(data.models);
  }

  function populateHouseModelBaseSelect(models) {
    const select = document.getElementById('house-model-base');
    const previousValue = select.value;
    select.innerHTML = '';
    for (const m of models) {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name;
      select.appendChild(opt);
    }
    if (previousValue && models.some((m) => m.name === previousValue)) select.value = previousValue;
  }

  function renderModels(models) {
    const tbody = document.getElementById('models-tbody');
    tbody.innerHTML = '';

    if (!models.length) return renderEmptyRow(tbody, 4, 'No local models pulled yet — pull one above to get started.');

    for (const m of models) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = m.name;

      const tdSize = document.createElement('td');
      tdSize.textContent = formatBytes(m.size);

      const tdModified = document.createElement('td');
      tdModified.textContent = formatDate(m.modified_at);

      const tdActions = document.createElement('td');
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'table-btn danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete local model "${m.name}"? Users will not be able to use it until it's pulled again.`)) return;
        const res = await fetch('/api/admin/models/delete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: m.name }),
        });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Could not delete model');
        await loadModels();
      });
      tdActions.appendChild(deleteBtn);

      tr.append(tdName, tdSize, tdModified, tdActions);
      tbody.appendChild(tr);
    }
  }

  const pullInput = document.getElementById('pull-model-input');
  const pullBtn = document.getElementById('pull-model-btn');
  const pullProgress = document.getElementById('pull-progress');

  pullBtn.addEventListener('click', async () => {
    const model = pullInput.value.trim();
    if (!model) return;

    hideError();
    pullBtn.disabled = true;
    pullInput.disabled = true;
    pullProgress.classList.remove('hidden');
    pullProgress.textContent = `Starting pull for "${model}"...`;

    try {
      const res = await fetch('/api/admin/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Pull failed');
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

          if (eventName === 'progress') {
            if (data.total && typeof data.completed === 'number') {
              const pct = ((data.completed / data.total) * 100).toFixed(1);
              pullProgress.textContent = `${data.status || 'downloading'} — ${pct}%`;
            } else {
              pullProgress.textContent = data.status || JSON.stringify(data);
            }
          } else if (eventName === 'error') {
            showError(data.error);
          } else if (eventName === 'done') {
            pullProgress.textContent = `Done. "${model}" is ready.`;
          }
        }
      }
      await loadModels();
      pullInput.value = '';
    } catch (err) {
      showError(err.message || 'Pull failed');
      pullProgress.textContent = 'Pull failed.';
    } finally {
      pullBtn.disabled = false;
      pullInput.disabled = false;
    }
  });

  // ---------- House model ----------

  const houseModelBaseSelect = document.getElementById('house-model-base');
  const houseModelNameInput = document.getElementById('house-model-name');
  const houseModelPromptInput = document.getElementById('house-model-prompt');
  const houseModelCreateBtn = document.getElementById('house-model-create-btn');
  const houseModelProgress = document.getElementById('house-model-progress');

  houseModelCreateBtn.addEventListener('click', async () => {
    const name = houseModelNameInput.value.trim();
    const baseModel = houseModelBaseSelect.value;
    const systemPrompt = houseModelPromptInput.value.trim();
    if (!name || !baseModel || !systemPrompt) return;

    hideError();
    houseModelCreateBtn.disabled = true;
    houseModelProgress.classList.remove('hidden');
    houseModelProgress.textContent = `Creating "${name}" from ${baseModel}...`;

    try {
      const res = await fetch('/api/admin/models/house', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, baseModel, systemPrompt }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Create failed');
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

          if (eventName === 'progress') {
            houseModelProgress.textContent = data.status || JSON.stringify(data);
          } else if (eventName === 'error') {
            showError(data.error);
          } else if (eventName === 'done') {
            houseModelProgress.textContent = `Done. "${name}" is ready in the model picker.`;
          }
        }
      }
      await loadModels();
    } catch (err) {
      showError(err.message || 'Create failed');
      houseModelProgress.textContent = 'Create failed.';
    } finally {
      houseModelCreateBtn.disabled = false;
    }
  });

  // ---------- External AI providers ----------

  const providerType = document.getElementById('provider-type');
  const providerName = document.getElementById('provider-name');
  const providerKey = document.getElementById('provider-key');
  const providerBaseUrl = document.getElementById('provider-base-url');
  const providerConnectBtn = document.getElementById('provider-connect-btn');
  const providersList = document.getElementById('providers-list');
  let providerTypes = {};

  async function providerRequest(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  async function loadProviders() {
    try {
      const data = await providerRequest('/api/admin/providers');
      providerTypes = data.types;
      if (!providerType.options.length) {
        for (const [value, info] of Object.entries(providerTypes)) {
          const opt = document.createElement('option');
          opt.value = value;
          opt.textContent = info.label;
          providerType.appendChild(opt);
        }
        applyProviderTypeDefaults();
      }
      renderProviders(data.providers);
    } catch (err) {
      showError(err.message);
    }
  }

  // Picking a provider fills in its official API address; "Other" leaves it blank to be typed.
  function applyProviderTypeDefaults() {
    const info = providerTypes[providerType.value] || {};
    providerBaseUrl.value = info.baseUrl || '';
    providerName.placeholder = info.label ? `e.g. ${info.label.replace(/ \(.*\)$/, '')}` : '';
    document.getElementById('provider-base-url-hint').textContent = info.baseUrl
      ? 'Filled in for you — only change it for a self-hosted or regional endpoint.'
      : "Your provider's OpenAI-compatible endpoint, e.g. https://api.groq.com/openai/v1";
  }
  providerType.addEventListener('change', applyProviderTypeDefaults);

  providerConnectBtn.addEventListener('click', async () => {
    hideError();
    providerConnectBtn.disabled = true;
    providerConnectBtn.textContent = 'Connecting...';
    try {
      await providerRequest('/api/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          type: providerType.value,
          name: providerName.value,
          apiKey: providerKey.value,
          baseUrl: providerBaseUrl.value,
        }),
      });
      providerKey.value = '';
      providerName.value = '';
      await loadProviders();
    } catch (err) {
      showError(err.message);
    } finally {
      providerConnectBtn.disabled = false;
      providerConnectBtn.textContent = 'Connect & load models';
    }
  });

  function renderProviders(providers) {
    providersList.innerHTML = '';
    if (!providers.length) {
      const empty = document.createElement('p');
      empty.className = 'admin-panel-hint';
      empty.textContent = 'No external providers connected. Staff can only use local models.';
      providersList.appendChild(empty);
      return;
    }
    for (const p of providers) providersList.appendChild(renderProviderCard(p));
  }

  function renderProviderCard(p) {
    const card = document.createElement('div');
    card.className = `provider-card${p.enabled ? '' : ' is-disabled'}`;

    const header = document.createElement('div');
    header.className = 'provider-card-header';
    const title = document.createElement('div');
    const nameEl = document.createElement('strong');
    nameEl.textContent = p.name;
    const meta = document.createElement('div');
    meta.className = 'provider-card-meta';
    meta.textContent = `${p.typeLabel} · ${p.baseUrl} · key ${p.keyHint} · ${p.enabledModels.length} of ${p.availableModels.length} models enabled`;
    title.append(nameEl, meta);

    const actions = document.createElement('div');
    actions.className = 'provider-card-actions';
    const toggle = document.createElement('label');
    toggle.className = 'provider-toggle';
    const toggleInput = document.createElement('input');
    toggleInput.type = 'checkbox';
    toggleInput.checked = p.enabled;
    toggleInput.addEventListener('change', () => saveProvider(p.id, { enabled: toggleInput.checked }));
    toggle.append(toggleInput, document.createTextNode(' Enabled'));

    const actionBtn = (label, onClick, danger) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `table-btn${danger ? ' danger' : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      return btn;
    };
    actions.append(
      toggle,
      actionBtn('Refresh models', async () => {
        hideError();
        try {
          await providerRequest(`/api/admin/providers/${p.id}/refresh`, { method: 'POST' });
          await loadProviders();
        } catch (err) {
          showError(err.message);
        }
      }),
      actionBtn('Change key', async () => {
        const apiKey = prompt(`New API key for ${p.name}:`);
        if (apiKey) await saveProvider(p.id, { apiKey });
      }),
      actionBtn(
        'Remove',
        async () => {
          if (!confirm(`Remove ${p.name}? Its models disappear from the model picker for everyone, and its API key is deleted.`)) return;
          try {
            await providerRequest(`/api/admin/providers/${p.id}`, { method: 'DELETE' });
            await loadProviders();
          } catch (err) {
            showError(err.message);
          }
        },
        true
      )
    );
    header.append(title, actions);
    card.appendChild(header);

    // Model checklist — a filter box helps with providers that list hundreds of models.
    const modelsWrap = document.createElement('div');
    modelsWrap.className = 'provider-models';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'provider-model-filter';
    filter.placeholder = `Filter ${p.availableModels.length} models...`;
    const grid = document.createElement('div');
    grid.className = 'provider-model-grid';
    const selected = new Set(p.enabledModels);
    // Enabled models first, so they're visible without scrolling a long list.
    const ordered = [...p.availableModels].sort((a, b) => Number(selected.has(b)) - Number(selected.has(a)) || a.localeCompare(b));
    for (const modelId of ordered) {
      const label = document.createElement('label');
      label.className = 'provider-model';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = selected.has(modelId);
      box.addEventListener('change', () => {
        if (box.checked) selected.add(modelId);
        else selected.delete(modelId);
        saveProvider(p.id, { enabledModels: [...selected] });
      });
      label.append(box, document.createTextNode(` ${modelId}`));
      grid.appendChild(label);
    }
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      for (const label of grid.children) label.classList.toggle('hidden', Boolean(q) && !label.textContent.toLowerCase().includes(q));
    });
    const hint = document.createElement('div');
    hint.className = 'field-hint';
    hint.textContent = 'Tick the models staff may use. Changes save immediately.';
    modelsWrap.append(filter, grid, hint);
    card.appendChild(modelsWrap);
    return card;
  }

  async function saveProvider(id, fields) {
    hideError();
    try {
      await providerRequest(`/api/admin/providers/${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
    } catch (err) {
      showError(err.message);
    }
    await loadProviders();
  }

  // ---------- Documents ----------

  const documentsFilter = document.getElementById('documents-filter');
  let allDocuments = [];

  function knowledgeBaseLabel(d) {
    if (d.scope === 'global') return 'Bank-wide';
    if (d.scope === 'personal') return `Personal (${d.department})`;
    return `${d.department} department`;
  }

  // Where the document actually lives: the server reports the knowledge folder it mirrors each file
  // into, by name (e.g. "Bank-wide", "Department - Credit", "Personal - ama"). Older servers don't
  // send it, so fall back to the scope label rather than showing an empty column.
  function folderLabel(d) {
    return d.folder || knowledgeBaseLabel(d);
  }

  async function loadDocuments() {
    // ?all=1 includes every staff member's personal chat files too, so an admin can manage storage.
    const res = await fetch('/api/documents?all=1');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load documents');
    allDocuments = data.documents;

    // Filter options: the three kinds of knowledge base, then each department that has files.
    const previous = documentsFilter.value;
    const departments = [...new Set(allDocuments.filter((d) => d.scope === 'department').map((d) => d.department))].sort();
    documentsFilter.innerHTML = '';
    const options = [
      ['', 'All knowledge bases'],
      ['global', 'Bank-wide'],
      ['department', 'All departments'],
      ...departments.map((dep) => [`department:${dep}`, `— ${dep}`]),
      ['personal', 'Personal (staff chat files)'],
    ];
    for (const [value, label] of options) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      documentsFilter.appendChild(opt);
    }
    documentsFilter.value = options.some(([v]) => v === previous) ? previous : '';

    const count = (scope) => allDocuments.filter((d) => d.scope === scope).length;
    document.getElementById('documents-counts').textContent =
      `${count('global')} bank-wide · ${count('department')} in departments · ${count('personal')} personal`;

    renderDocuments();
  }

  documentsFilter.addEventListener('change', renderDocuments);

  function renderDocuments() {
    const filter = documentsFilter.value;
    const documents = allDocuments.filter((d) => {
      if (!filter) return true;
      if (filter.startsWith('department:')) return d.scope === 'department' && d.department === filter.slice(11);
      return d.scope === filter;
    });
    const tbody = document.getElementById('documents-tbody');
    tbody.innerHTML = '';

    if (!documents.length) return renderEmptyRow(tbody, 6, filter ? 'No documents in this knowledge base.' : 'No documents uploaded yet.');

    for (const d of documents) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = d.filename;

      const tdFolder = document.createElement('td');
      tdFolder.textContent = folderLabel(d);

      const tdUploader = document.createElement('td');
      tdUploader.textContent = d.uploaded_by;

      const tdSize = document.createElement('td');
      tdSize.textContent = `${d.char_count.toLocaleString()} chars`;

      const tdAdded = document.createElement('td');
      tdAdded.textContent = formatDate(d.created_at);

      const tdActions = document.createElement('td');
      tdActions.className = 'admin-doc-actions';

      const downloadLink = document.createElement('a');
      downloadLink.className = 'table-btn';
      downloadLink.href = `/api/documents/${d.id}/file?download=1`;
      downloadLink.textContent = 'Download';
      tdActions.appendChild(downloadLink);

      // Turning a department file into bank policy is an admin decision, so it lives here. Personal
      // files aren't offered this — their owner decides whether to share them first.
      if (d.scope === 'department') {
        const publishBtn = document.createElement('button');
        publishBtn.className = 'table-btn';
        publishBtn.textContent = 'Publish bank-wide';
        publishBtn.addEventListener('click', async () => {
          if (!confirm(`Publish "${d.filename}" bank-wide? Every member of staff will be able to search it, not just ${d.department}.`)) return;
          const res = await fetch(`/api/documents/${d.id}/share`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scope: 'global' }),
          });
          const data = await res.json();
          if (!res.ok) return showError(data.error || 'Could not publish document');
          await loadDocuments();
        });
        tdActions.appendChild(publishBtn);
      }

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'table-btn danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${d.filename}" from ${knowledgeBaseLabel(d)}?`)) return;
        const res = await fetch(`/api/documents/${d.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Could not delete document');
        await loadDocuments();
      });
      tdActions.appendChild(deleteBtn);

      tr.append(tdName, tdFolder, tdUploader, tdSize, tdAdded, tdActions);
      tbody.appendChild(tr);
    }
  }

  // ---------- Tools (domain allowlist) ----------

  async function loadDomains() {
    const res = await fetch('/api/admin/domains');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load approved domains');
    renderDomains(data.domains);
  }

  function renderDomains(domains) {
    const tbody = document.getElementById('domains-tbody');
    tbody.innerHTML = '';

    if (!domains.length) {
      return renderEmptyRow(tbody, 4, 'No domains approved yet — the web fetch tool will refuse every request until you add one.');
    }

    for (const d of domains) {
      const tr = document.createElement('tr');

      const tdDomain = document.createElement('td');
      tdDomain.textContent = d.domain;

      const tdAddedBy = document.createElement('td');
      tdAddedBy.textContent = d.added_by || '—';

      const tdAdded = document.createElement('td');
      tdAdded.textContent = formatDate(d.created_at);

      const tdActions = document.createElement('td');
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'table-btn danger';
      deleteBtn.textContent = 'Remove';
      deleteBtn.addEventListener('click', async () => {
        const res = await fetch(`/api/admin/domains/${d.id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Could not remove domain');
        await loadDomains();
      });
      tdActions.appendChild(deleteBtn);

      tr.append(tdDomain, tdAddedBy, tdAdded, tdActions);
      tbody.appendChild(tr);
    }
  }

  document.getElementById('domain-add-btn').addEventListener('click', async () => {
    const input = document.getElementById('domain-input');
    const domain = input.value.trim();
    if (!domain) return;
    hideError();
    const res = await fetch('/api/admin/domains', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain }),
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not add domain');
    input.value = '';
    await loadDomains();
  });

  // ---------- Settings (web search) ----------

  async function loadSettings() {
    const res = await fetch('/api/admin/settings');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load settings');
    document.getElementById('web-search-toggle').checked = data.webSearchEnabled;
    document.getElementById('search-restricted-toggle').checked = data.searchRestricted;
    document.getElementById('external-redaction-toggle').checked = data.externalRedaction;
    // Fallback from the bank's own policies to the approved websites. Older servers don't send the
    // key at all, so treat "missing" as off rather than leaving the checkbox in a stale state.
    document.getElementById('kb-online-fallback-toggle').checked = Boolean(data.kbOnlineFallback);
  document.getElementById('exchange-rate-toggle').checked = Boolean(data.exchangeRateEnabled);
  document.getElementById('exchange-rate-url-input').value = data.exchangeRateUrl || '';
    if (data.houseModel) {
      document.getElementById('house-model-name').value = data.houseModel.name;
      document.getElementById('house-model-prompt').value = data.houseModel.systemPrompt;
      const baseSelect = document.getElementById('house-model-base');
      if ([...baseSelect.options].some((o) => o.value === data.houseModel.baseModel)) {
        baseSelect.value = data.houseModel.baseModel;
      }
    }
    document.getElementById('retention-days-input').value = data.retentionDays || 0;
  }

  async function updateSetting(key, checkbox) {
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: checkbox.checked }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showError(data.error || 'Could not update setting');
      checkbox.checked = !checkbox.checked; // revert
    }
  }

  document.getElementById('web-search-toggle').addEventListener('change', (e) => updateSetting('webSearchEnabled', e.target));
  document.getElementById('search-restricted-toggle').addEventListener('change', (e) => updateSetting('searchRestricted', e.target));
  document.getElementById('external-redaction-toggle').addEventListener('change', (e) => updateSetting('externalRedaction', e.target));
  document.getElementById('kb-online-fallback-toggle').addEventListener('change', (e) => updateSetting('kbOnlineFallback', e.target));
  document.getElementById('exchange-rate-toggle').addEventListener('change', (e) =>
    updateSetting('exchangeRateEnabled', e.target)
  );
  document.getElementById('exchange-rate-url-save').addEventListener('click', async () => {
    const url = document.getElementById('exchange-rate-url-input').value.trim();
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exchangeRateUrl: url }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || 'Could not save the rate address');
    document.getElementById('exchange-rate-url-input').value = data.exchangeRateUrl || url;
    return showError('');
  });

  // ---------- Analytics ----------

  function statCard(label, value) {
    const card = document.createElement('div');
    card.className = 'analytics-stat-card';
    const valueEl = document.createElement('div');
    valueEl.className = 'analytics-stat-value';
    valueEl.textContent = value;
    const labelEl = document.createElement('div');
    labelEl.className = 'analytics-stat-label';
    labelEl.textContent = label;
    card.appendChild(valueEl);
    card.appendChild(labelEl);
    return card;
  }

  function renderTwoColRows(tbody, rows, colSpan, emptyMessage, cellsFor) {
    tbody.innerHTML = '';
    if (!rows.length) return renderEmptyRow(tbody, colSpan, emptyMessage);
    for (const row of rows) {
      const tr = document.createElement('tr');
      for (const text of cellsFor(row)) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  async function loadAnalytics() {
    hideError();
    const res = await fetch('/api/admin/analytics');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load analytics');

    const totalsWrap = document.getElementById('analytics-totals');
    totalsWrap.innerHTML = '';
    totalsWrap.appendChild(statCard('Staff accounts', data.totals.users));
    totalsWrap.appendChild(statCard('Conversations', data.totals.conversations));
    totalsWrap.appendChild(statCard('Messages', data.totals.messages));
    totalsWrap.appendChild(statCard('Documents', data.totals.documents));

    renderTwoColRows(
      document.getElementById('analytics-department-tbody'),
      data.messagesByDepartment,
      2,
      'No messages yet.',
      (r) => [r.department, r.count]
    );

    renderTwoColRows(
      document.getElementById('analytics-model-tbody'),
      data.messagesByModel,
      2,
      'No replies yet.',
      (r) => [r.model, r.count]
    );

    const feedbackWrap = document.getElementById('analytics-feedback');
    feedbackWrap.innerHTML = '';
    feedbackWrap.appendChild(statCard('Thumbs up', data.feedback.up || 0));
    feedbackWrap.appendChild(statCard('Thumbs down', data.feedback.down || 0));

    renderTwoColRows(
      document.getElementById('analytics-users-tbody'),
      data.topUsers,
      3,
      'No activity yet.',
      (r) => [r.username, r.department || '—', r.count]
    );

    renderTwoColRows(
      document.getElementById('analytics-documents-tbody'),
      data.topDocuments,
      2,
      'No documents cited yet.',
      (r) => [r.filename, r.count]
    );
  }

  // ---------- System: backup & retention ----------

  document.getElementById('backup-download-btn').addEventListener('click', () => {
    window.location.href = '/api/admin/backup';
  });

  document.getElementById('retention-save-btn').addEventListener('click', async () => {
    const days = Number(document.getElementById('retention-days-input').value) || 0;
    const res = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retentionDays: days }),
    });
    const data = await res.json();
    if (!res.ok) showError(data.error || 'Could not save retention setting');
  });

  document.getElementById('retention-cleanup-btn').addEventListener('click', async () => {
    const days = Number(document.getElementById('retention-days-input').value) || 0;
    if (days < 1) {
      showError('Set a retention period of 1 day or more before running cleanup.');
      return;
    }

    const previewRes = await fetch(`/api/admin/cleanup-old-conversations/preview?retentionDays=${days}`);
    const preview = await previewRes.json();
    if (!previewRes.ok) return showError(preview.error || 'Could not preview cleanup');

    if (!preview.count) {
      alert('Nothing to clean up — no conversations are older than that.');
      return;
    }

    const sampleLines = preview.sample
      .map((c) => `  ${c.username} — "${c.title}" (last updated ${c.updated_at})`)
      .join('\n');
    const more = preview.count > preview.sample.length ? `\n  ...and ${preview.count - preview.sample.length} more` : '';
    const confirmed = confirm(
      `This will PERMANENTLY delete ${preview.count} conversation(s) last updated more than ${days} day(s) ago, ` +
        `across every user. This cannot be undone.\n\nIncludes:\n${sampleLines}${more}\n\nProceed?`
    );
    if (!confirmed) return;

    const res = await fetch('/api/admin/cleanup-old-conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ retentionDays: days }),
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Cleanup failed');
    alert(`Deleted ${data.deleted} conversation(s).`);
  });

  // ---------- Users: bulk CSV import ----------

  const importCsvInput = document.getElementById('import-csv-input');
  const importResultsEl = document.getElementById('import-results');

  document.getElementById('import-csv-btn').addEventListener('click', () => importCsvInput.click());

  importCsvInput.addEventListener('change', async () => {
    const file = importCsvInput.files[0];
    if (!file) return;
    const text = await file.text();
    importCsvInput.value = '';

    const res = await fetch('/api/admin/users/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv: text }),
    });
    const data = await res.json();
    if (!res.ok) {
      showError(data.error || 'Import failed');
      return;
    }

    importResultsEl.classList.remove('hidden');
    importResultsEl.innerHTML = '';
    if (data.created.length) {
      const created = document.createElement('div');
      created.className = 'import-created';
      created.innerHTML =
        `<strong>${data.created.length} account(s) created:</strong><br>` +
        data.created.map((c) => `${escapeHtml(c.username)} — temp password: <code>${escapeHtml(c.tempPassword)}</code>`).join('<br>');
      importResultsEl.appendChild(created);
    }
    if (data.skipped.length) {
      const skipped = document.createElement('div');
      skipped.className = 'import-skipped';
      skipped.innerHTML =
        `<strong>${data.skipped.length} row(s) skipped:</strong><br>` +
        data.skipped.map((s) => `Row ${s.row} (${escapeHtml(s.username || '—')}): ${escapeHtml(s.reason)}`).join('<br>');
      importResultsEl.appendChild(skipped);
    }
    if (!data.created.length && !data.skipped.length) {
      importResultsEl.textContent = 'No rows found in that file.';
    }
    await loadUsers();
  });

  // ---------- Operations ----------

  let operationsTimer = null;

  function formatUptime(seconds) {
    if (seconds == null) return '—';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m`;
    return `${Math.round(seconds)}s`;
  }

  function formatClock(iso) {
    if (!iso) return '—';
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function card(label, value, hint) {
    const el = statCard(label, value);
    if (hint) {
      const hintEl = document.createElement('div');
      hintEl.className = 'analytics-stat-label';
      hintEl.textContent = hint;
      el.appendChild(hintEl);
    }
    return el;
  }

  function renderOperations(status) {
    const cards = document.getElementById('operations-cards');
    cards.innerHTML = '';
    cards.appendChild(card('App uptime', formatUptime(status.app.uptimeSeconds), status.app.service ? 'running as a Windows service' : `pid ${status.app.pid} · Node ${status.app.node}`));
    cards.appendChild(
      card(
        'Ollama',
        status.ollama.reachable ? 'reachable' : 'unreachable',
        status.ollama.reachable ? `v${status.ollama.version || '?'} · ${status.ollama.latencyMs} ms · ${status.ollama.installedModels} models` : status.ollama.error
      )
    );
    cards.appendChild(card('CPU', status.machine.cpuPercent == null ? '—' : `${status.machine.cpuPercent}%`, `${status.machine.cpuCount} cores`));
    cards.appendChild(card('Memory', `${status.machine.memoryUsedMb} / ${status.machine.memoryTotalMb} MB`, `app uses ${status.app.memoryMb} MB`));
    cards.appendChild(
      card(
        'Waiting line',
        `${status.queue.active} answering · ${status.queue.waiting} waiting`,
        status.queue.waiting ? `oldest wait ${status.queue.oldestWaitSeconds}s · avg reply ${status.queue.averageSeconds}s` : `average reply ${status.queue.averageSeconds}s`
      )
    );
    cards.appendChild(card('Image service', status.imageService.ready ? 'ready' : status.imageService.loading ? 'loading' : 'not available', status.imageService.error || ''));

    // Models currently held in memory.
    const ollamaBody = document.getElementById('operations-ollama-tbody');
    ollamaBody.innerHTML = '';
    const loaded = status.ollama.loadedModels || [];
    if (!loaded.length) {
      renderEmptyRow(ollamaBody, 3, status.ollama.reachable ? 'No model is loaded right now — the first message will load one.' : 'Ollama is not reachable.');
    } else {
      for (const m of loaded) {
        const tr = document.createElement('tr');
        const cells = [m.name, `${m.sizeMb} MB`, m.expiresAt ? formatClock(m.expiresAt) : '—'];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        ollamaBody.appendChild(tr);
      }
    }
    document.getElementById('operations-ollama-note').textContent = status.ollama.reachable
      ? `Ollama at ${status.ollama.url}. Models stay loaded between messages (OLLAMA_KEEP_ALIVE), so the first question after a restart is the slow one.`
      : `Ollama at ${status.ollama.url} is not answering. Chats will fail until it is running, or until a fallback model takes over (Model routing tab).`;

    // Machine details.
    const machineBody = document.getElementById('operations-machine-tbody');
    machineBody.innerHTML = '';
    const gpus = status.machine.gpus;
    const machineRows = [
      ['Computer', `${status.machine.hostname} (${status.machine.platform})`],
      [
        'CPU',
        status.machine.cpuHistory?.length
          ? `${sparkline(status.machine.cpuHistory)} ${status.machine.cpuPercent}% now, last 5 minutes`
          : '—',
      ],
      ['GPU', gpus === null ? 'No NVIDIA GPU detected' : gpus.map((g) => `${g.name} — ${g.utilizationPercent}% · ${g.memoryUsedMb}/${g.memoryTotalMb} MB · ${g.temperatureC}°C`).join(', ')],
      ['Database', formatBytes(status.storage.databaseBytes)],
      ['Logs', formatBytes(status.storage.logsBytes)],
      ['Free disk', status.storage.diskFreeBytes == null ? '—' : `${formatBytes(status.storage.diskFreeBytes)} of ${formatBytes(status.storage.diskTotalBytes)}`],
      ['Message limits', `${status.rateLimit.perMinute || 'no'} / minute · ${status.rateLimit.perHour || 'no'} / hour per person`],
    ];
    for (const [label, value] of machineRows) {
      const tr = document.createElement('tr');
      const th = document.createElement('td');
      th.textContent = label;
      th.className = 'data-label';
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(th, td);
      machineBody.appendChild(tr);
    }

    // Per-model health observed by real chats this run.
    const healthBody = document.getElementById('operations-modelhealth-tbody');
    healthBody.innerHTML = '';
    const health = Object.entries(status.modelHealth || {});
    if (!health.length) {
      renderEmptyRow(healthBody, 4, 'No chat has used a model since the server started.');
    } else {
      for (const [model, h] of health.sort((a, b) => b[1].failed - a[1].failed || b[1].ok - a[1].ok)) {
        const tr = document.createElement('tr');
        for (const text of [model, String(h.ok), String(h.failed), h.lastError || '—']) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        healthBody.appendChild(tr);
      }
    }
  }

  // A tiny text bar chart of CPU history, so a spike is visible at a glance.
  function sparkline(values) {
    const blocks = '▁▂▃▄▅▆▇█';
    return values.map((v) => blocks[Math.min(blocks.length - 1, Math.floor((v / 100) * blocks.length))]).join('');
  }

  async function loadOperations() {
    try {
      const res = await fetch('/api/admin/operations/status');
      const data = await res.json();
      if (!res.ok) return showError(data.error || 'Could not load system status');
      renderOperations(data);
      return undefined;
    } catch (err) {
      return showError(`Could not reach the server: ${err.message}`);
    }
  }

  async function loadOperationsLimits() {
    const res = await fetch('/api/admin/operations/limits');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load limits');
    document.getElementById('limit-queue-concurrency').value = data.queueConcurrency;
    document.getElementById('limit-queue-waiting').value = data.queueMaxWaiting;
    document.getElementById('limit-queue-peruser').value = data.queuePerUser;
    document.getElementById('limit-rate-minute').value = data.rateLimitPerMinute;
    document.getElementById('limit-rate-hour').value = data.rateLimitPerHour;
    return undefined;
  }

  async function loadLogs() {
    const level = document.getElementById('logs-level').value;
    const q = document.getElementById('logs-filter').value.trim();
    const res = await fetch(`/api/admin/operations/logs?level=${encodeURIComponent(level)}&q=${encodeURIComponent(q)}&limit=200`);
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not read the log');
    const tbody = document.getElementById('logs-tbody');
    tbody.innerHTML = '';
    if (!data.entries.length) {
      renderEmptyRow(tbody, 3, 'Nothing logged at this level yet.');
    } else {
      for (const e of data.entries) {
        const tr = document.createElement('tr');
        const { msg, level: lvl, t, stack, ...fields } = e;
        const detail = Object.keys(fields).length ? ` — ${JSON.stringify(fields)}` : '';
        const cells = [formatClock(t), lvl, `${msg}${detail}`];
        cells.forEach((text, i) => {
          const td = document.createElement('td');
          td.textContent = text;
          if (i === 2) td.title = stack || text;
          if (i === 1) td.className = `log-level log-level-${lvl}`;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      }
    }
    document.getElementById('logs-hint').textContent = `Log file: ${data.file}`;
    return undefined;
  }

  function startOperations() {
    hideError();
    loadOperations();
    loadOperationsLimits();
    loadLogs();
    stopOperations();
    operationsTimer = setInterval(loadOperations, 5000);
  }

  function stopOperations() {
    if (operationsTimer) clearInterval(operationsTimer);
    operationsTimer = null;
  }

  document.getElementById('limits-save-btn').addEventListener('click', async () => {
    hideError();
    const body = {
      queueConcurrency: Number(document.getElementById('limit-queue-concurrency').value),
      queueMaxWaiting: Number(document.getElementById('limit-queue-waiting').value),
      queuePerUser: Number(document.getElementById('limit-queue-peruser').value),
      rateLimitPerMinute: Number(document.getElementById('limit-rate-minute').value),
      rateLimitPerHour: Number(document.getElementById('limit-rate-hour').value),
    };
    const res = await fetch('/api/admin/operations/limits', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || 'Could not save limits');
    document.getElementById('limits-hint').textContent = 'Saved — staff see this on their next message.';
    return loadOperations();
  });

  document.getElementById('logs-refresh-btn').addEventListener('click', loadLogs);
  document.getElementById('logs-level').addEventListener('change', loadLogs);
  document.getElementById('logs-filter').addEventListener('change', loadLogs);

  // ---------- Model routing & quality ----------

  let routingModels = [];
  let routingState = { departmentModels: {}, fallbackModels: [], fallbackEnabled: true };

  async function loadRouting() {
    hideError();
    const res = await fetch('/api/admin/routing');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load model routing');

    routingModels = data.models;
    routingState = {
      departmentModels: { ...data.departmentModels },
      fallbackModels: [...data.fallbackModels],
      fallbackEnabled: data.fallbackEnabled,
    };
    document.getElementById('routing-global-default').textContent = data.globalDefault || '(DEFAULT_MODEL in .env)';

    renderDepartmentDefaults(data.departments);
    renderFallback();
    await loadQuality();
    return undefined;
  }

  function modelOption(value, label) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  function modelLabel(name) {
    const found = routingModels.find((m) => m.name === name);
    return found ? found.label : name;
  }

  function renderDepartmentDefaults(deps) {
    const tbody = document.getElementById('routing-departments-tbody');
    tbody.innerHTML = '';
    if (!deps.length) return renderEmptyRow(tbody, 2, 'No departments configured.');
    for (const dept of deps) {
      const tr = document.createElement('tr');
      const nameCell = document.createElement('td');
      nameCell.textContent = dept;
      const selectCell = document.createElement('td');
      const select = document.createElement('select');
      select.className = 'routing-select';
      select.appendChild(modelOption('', 'Global default'));
      for (const m of routingModels) {
        select.appendChild(modelOption(m.name, m.external ? `☁ ${m.label}` : m.label));
      }
      select.value = routingState.departmentModels[dept] || '';
      select.addEventListener('change', () => saveRouting({ departmentModels: { ...routingState.departmentModels, [dept]: select.value } }));
      selectCell.appendChild(select);
      tr.append(nameCell, selectCell);
      tbody.appendChild(tr);
    }
    return undefined;
  }

  function renderFallback() {
    document.getElementById('fallback-toggle').checked = routingState.fallbackEnabled;
    const list = document.getElementById('fallback-list');
    list.innerHTML = '';
    if (!routingState.fallbackModels.length) {
      const li = document.createElement('li');
      li.className = 'admin-table-empty';
      li.textContent = 'No fallback models yet — when one fails, the person sees the error (after the global default has also been tried, if it is local).';
      list.appendChild(li);
    }
    routingState.fallbackModels.forEach((model, i) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${i + 1}. ${modelLabel(model)}${model.startsWith('ext/') ? ' (external — leaves this machine)' : ''}`;
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'table-btn';
      up.textContent = '↑';
      up.disabled = i === 0;
      up.addEventListener('click', () => move(i, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'table-btn';
      down.textContent = '↓';
      down.disabled = i === routingState.fallbackModels.length - 1;
      down.addEventListener('click', () => move(i, 1));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'table-btn danger';
      remove.textContent = 'Remove';
      remove.addEventListener('click', () => saveRouting({ fallbackModels: routingState.fallbackModels.filter((m) => m !== model) }));
      li.append(label, up, down, remove);
      list.appendChild(li);
    });

    const select = document.getElementById('fallback-add-select');
    select.innerHTML = '';
    for (const m of routingModels.filter((x) => !routingState.fallbackModels.includes(x.name))) {
      select.appendChild(modelOption(m.name, m.external ? `☁ ${m.label}` : m.label));
    }
    document.getElementById('fallback-add-btn').disabled = !select.options.length;

    function move(i, delta) {
      const next = [...routingState.fallbackModels];
      const [item] = next.splice(i, 1);
      next.splice(i + delta, 0, item);
      saveRouting({ fallbackModels: next });
    }
  }

  async function saveRouting(fields) {
    hideError();
    const res = await fetch('/api/admin/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || 'Could not save model routing');
    return loadRouting();
  }

  document.getElementById('fallback-toggle').addEventListener('change', (e) => saveRouting({ fallbackEnabled: e.target.checked }));
  document.getElementById('fallback-add-btn').addEventListener('click', () => {
    const model = document.getElementById('fallback-add-select').value;
    if (model) saveRouting({ fallbackModels: [...routingState.fallbackModels, model] });
  });
  document.getElementById('quality-refresh-btn').addEventListener('click', loadQuality);
  document.getElementById('quality-range').addEventListener('change', loadQuality);

  function verdictBadge(verdict) {
    const span = document.createElement('span');
    span.className = `verdict verdict-${verdict}`;
    span.textContent =
      verdict === 'review' ? 'Review' : verdict === 'good' ? 'Good' : verdict === 'ok' ? 'OK' : 'Too few ratings';
    return span;
  }

  async function loadQuality() {
    const days = document.getElementById('quality-range').value;
    const res = await fetch(`/api/admin/quality?days=${days}`);
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load the quality report');

    const tbody = document.getElementById('quality-tbody');
    tbody.innerHTML = '';
    if (!data.models.length) {
      renderEmptyRow(tbody, 7, 'No answers yet.');
    } else {
      for (const m of data.models) {
        const tr = document.createElement('tr');
        const cells = [
          m.model,
          String(m.answers),
          m.rated ? `${m.up} ↑ / ${m.down} ↓` : '—',
          m.approval == null ? '—' : `${Math.round(m.approval * 100)}%`,
          m.averageSeconds == null ? '—' : `${m.averageSeconds}s`,
          String(m.servedAsFallback),
        ];
        for (const text of cells) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        const verdictCell = document.createElement('td');
        verdictCell.appendChild(verdictBadge(m.verdict));
        tr.appendChild(verdictCell);
        tbody.appendChild(tr);
      }
    }

    const suggestions = document.getElementById('quality-suggestions');
    suggestions.innerHTML = '';
    if (data.suggestions.length) {
      const box = document.createElement('div');
      box.className = 'quality-suggestions';
      for (const s of data.suggestions) {
        const line = document.createElement('div');
        line.className = 'quality-suggestion';
        line.innerHTML =
          `<strong>${escapeHtml(s.department)}</strong>: staff there rate <strong>${escapeHtml(s.suggested)}</strong> ` +
          `higher (${Math.round(s.approval * 100)}% of ${s.rated} ratings)` +
          (s.current ? ` than the current default <strong>${escapeHtml(s.current)}</strong>` : '') +
          '. Consider making it their default above.';
        box.appendChild(line);
      }
      suggestions.appendChild(box);
    }

    const downBody = document.getElementById('quality-downvotes-tbody');
    downBody.innerHTML = '';
    if (!data.recentDownvotes.length) {
      renderEmptyRow(downBody, 5, 'No thumbs down yet.');
    } else {
      for (const d of data.recentDownvotes) {
        const tr = document.createElement('tr');
        for (const text of [formatDate(d.at), d.model, d.department, d.question || '—', d.answer || '—']) {
          const td = document.createElement('td');
          td.textContent = text;
          tr.appendChild(td);
        }
        downBody.appendChild(tr);
      }
    }
    return undefined;
  }

  // ---------- Language ----------
  //
  // The server owns the allowed languages, the glossary limits and the actual prompt wording (see
  // server/languageSettings.js). This tab only edits that state. Two rules shape it:
  //  - a language is offered for a model only after a real capability test of that model+language
  //    passed, so the Languages table says which models each language is approved on;
  //  - a test makes several real model calls and takes minutes on a CPU-only machine, so it runs as
  //    Server-Sent Events with live per-step progress and a working Stop button.
  //
  // Nothing here is loaded at page load — the tab fetches its data when opened (loadLanguageTab).

  const defaultLanguageSelect = document.getElementById('default-language-select');
  const languageChoiceToggle = document.getElementById('language-choice-toggle');
  const searchTranslationToggle = document.getElementById('search-translation-toggle');
  const terminologyApprovalToggle = document.getElementById('terminology-approval-toggle');
  const capabilityModelSelect = document.getElementById('capability-model-select');
  const capabilityLanguageOptions = document.getElementById('capability-language-options');
  const capabilityRunBtn = document.getElementById('capability-run-btn');
  const capabilityStopBtn = document.getElementById('capability-stop-btn');
  const capabilityProgress = document.getElementById('capability-progress');
  const capabilityResultsEl = document.getElementById('capability-results');
  const capabilityExternalNote = document.getElementById('capability-external-note');
  const termsLanguageSelect = document.getElementById('terms-language-select');
  const termsSearchInput = document.getElementById('terms-search');
  const termsEnInput = document.getElementById('terms-en-input');
  const termsLocalInput = document.getElementById('terms-local-input');
  const termsContextInput = document.getElementById('terms-context-input');
  const termsStatusTh = document.getElementById('terms-status-th');
  const termsTbody = document.getElementById('terms-tbody');
  const termsHint = document.getElementById('terms-hint');
  const languageStatsEl = document.getElementById('language-stats');
  const languageFromInput = document.getElementById('language-from');
  const languageToInput = document.getElementById('language-to');
  const languageFilterLanguage = document.getElementById('language-filter-language');
  const languageFilterProvider = document.getElementById('language-filter-provider');
  const languageFilterModel = document.getElementById('language-filter-model');
  const languageUsageTbody = document.getElementById('language-usage-tbody');
  const languageModelTbody = document.getElementById('language-model-tbody');
  const languageTrendChart = document.getElementById('language-trend-chart');
  const languageTrendTbody = document.getElementById('language-trend-tbody');
  const languageStatsRange = document.getElementById('language-stats-range');
  const languageEventsSummary = document.getElementById('language-events-summary');
  const languageEventsRecurring = document.getElementById('language-events-recurring');
  const languageEventsTbody = document.getElementById('language-events-tbody');

  // Last GET /api/admin/language payload — the single source of truth for labels, enabled state,
  // approvals and which models exist. Replaced wholesale after every save or test run.
  let languageData = null;
  let capabilityRun = null; // { controller, running, rows: Map(code -> row elements), model }
  let termsSearchTimer = null;
  let languageStatusTimer = null;
  // Approval state, limits and per-language counts come from the terms endpoint, because it is the
  // endpoint that enforces them. Kept here so every re-render (search, add, approve) displays the
  // same numbers the server just applied.
  let termsMeta = { approvalRequired: false, limits: { maxTerms: 200, maxLength: 60 }, counts: {} };
  // Usage filters are applied explicitly (Apply/Clear), so typing in a date box does not re-query on
  // every keystroke. The values are kept here so a re-render after an unrelated save keeps them.
  let languageStatsFilters = { from: '', to: '', language: '', provider: '', model: '' };
  let languageStatsSeq = 0;

  function showLanguageStatus(message) {
    const el = document.getElementById('language-status-note');
    el.textContent = message;
    el.classList.remove('hidden');
    clearTimeout(languageStatusTimer);
    languageStatusTimer = setTimeout(() => el.classList.add('hidden'), 9000);
  }

  function languageLabel(code) {
    return (languageData?.languages || []).find((l) => l.code === code)?.label || code;
  }

  function enabledLanguageCodes() {
    return (languageData?.languages || []).filter((l) => l.enabled).map((l) => l.code);
  }

  // Model names are shown with the ☁ mark when they leave the bank's machine — the same convention as
  // the model picker and Model routing tab.
  function capabilityModelLabel(model) {
    return model.external ? `☁ ${model.label || model.name}` : model.label || model.name;
  }

  function modelByCapabilityName(name) {
    return (languageData?.models || []).find((m) => m.name === name) || null;
  }

  // Scores come back as 0–1; a percentage is easier to scan than "0.75".
  function scorePercent(score) {
    if (score == null || Number.isNaN(Number(score))) return '—';
    return `${Math.round(Number(score) * 100)}%`;
  }

  function statusBadge(status) {
    const span = document.createElement('span');
    span.className = `verdict ${status === 'approved' ? 'verdict-good' : 'verdict-review'}`;
    span.textContent = status === 'approved' ? 'Approved' : status === 'failed' ? 'Failed' : status || '—';
    return span;
  }

  // ---------- Language tab: loading ----------

  async function loadLanguageTab() {
    hideError();
    await loadLanguageSettings();
    if (!languageData) return;
    // The capability list also carries the models the tests can run against (local + enabled
    // external), so the model picker is only filled once that call is done.
    await loadCapabilityHistory();
    await Promise.all([loadLanguageStats(), loadTerms()]);
  }

  async function loadLanguageSettings() {
    const res = await fetch('/api/admin/language');
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Could not load language settings');
      return;
    }
    // The summary itself has no `models` list (that comes from /capabilities); keep the ones already
    // known so re-rendering after a save doesn't briefly empty the model picker.
    const knownModels = languageData?.models || [];
    languageData = { ...data, models: Array.isArray(data.models) ? data.models : knownModels };
    renderDefaultLanguageSelect();
    renderLanguageTable();
    renderCapabilityModelSelect();
    renderCapabilityLanguageOptions();
    renderTermsLanguageSelect();
    languageChoiceToggle.checked = data.choiceAllowed !== false;
    searchTranslationToggle.checked = data.searchTranslation !== false;
    // Older server payloads predate the approval workflow; absent means "not required" (off).
    terminologyApprovalToggle.checked = data.terminologyApproval === true;
  }

  // Turns the POST /api/admin/language response into a short confirmation line. The important case is
  // `reverted`: switching a language off (or a failed capability test) quietly moves affected staff
  // back to the default, and the admin should see that it happened.
  function reportLanguageSave(data) {
    const reverted = data.reverted && typeof data.reverted === 'object' ? data.reverted : {};
    const parts = Object.entries(reverted)
      .map(([code, count]) => `${count} staff member${Number(count) === 1 ? ' was' : 's were'} moved back to English because ${languageLabel(code)} is no longer available`)
      .filter(Boolean);
    if (data.defaultWasReset) parts.push('The default was switched back to English because that language is no longer enabled');
    if (parts.length) showLanguageStatus(`Saved. ${parts.join('; ')}.`);
  }

  async function saveLanguageSettings(fields) {
    hideError();
    const res = await fetch('/api/admin/language', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showError(data.error || 'Could not save language settings');
      // Put the controls back to what the server still has, so a refused change isn't left showing.
      await loadLanguageSettings();
      return false;
    }
    reportLanguageSave(data);
    // Re-read everything from the server: a save can change which languages are offered, which users
    // were reverted, and what the terms/stats should show.
    await loadLanguageSettings();
    await loadCapabilityHistory();
    await Promise.all([loadLanguageStats(), loadTerms()]);
    return true;
  }

  // ---------- Block 1: languages ----------

  function renderDefaultLanguageSelect() {
    const previous = defaultLanguageSelect.value;
    defaultLanguageSelect.innerHTML = '';
    const enabled = (languageData.languages || []).filter((language) => language.enabled);
    for (const language of enabled) {
      const opt = document.createElement('option');
      opt.value = language.code;
      opt.textContent = language.label;
      defaultLanguageSelect.appendChild(opt);
    }
    const codes = enabled.map((language) => language.code);
    const preferred = [previous, languageData.defaultLanguage].find((code) => code && codes.includes(code));
    if (preferred) defaultLanguageSelect.value = preferred;
  }

  // A short, factual caution on a row whose language staff can't actually use yet: enabled, but the
  // bank's default model has not passed a test in it. Naming the model is what makes it actionable.
  function notApprovedCaution(language) {
    const model = languageData.bankDefaultModel;
    if (!language.enabled || language.code === 'en' || language.bankDefaultApproved || !model) return null;
    const span = document.createElement('span');
    span.className = 'capability-caution';
    span.textContent = `not approved for ${model} — staff can't use it yet; run a capability test`;
    return span;
  }

  function renderLanguageTable() {
    const tbody = document.getElementById('language-tbody');
    tbody.innerHTML = '';
    const languages = languageData.languages || [];
    if (!languages.length) return renderEmptyRow(tbody, 5, 'No languages configured.');

    for (const language of languages) {
      const isEnglish = language.code === 'en';
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      const name = document.createElement('strong');
      name.textContent = language.label;
      tdName.appendChild(name);
      if (language.native && language.native !== language.label) {
        const native = document.createElement('div');
        native.className = 'language-native-name';
        native.textContent = language.native;
        tdName.appendChild(native);
      }

      const tdEnabled = document.createElement('td');
      if (isEnglish) {
        // English is the bank's working language and the always-available fallback: no off switch.
        const locked = document.createElement('span');
        locked.className = 'language-locked-label';
        locked.textContent = 'Default language';
        tdEnabled.appendChild(locked);
      } else {
        const toggle = document.createElement('input');
        toggle.type = 'checkbox';
        toggle.className = 'language-enabled-toggle';
        toggle.checked = Boolean(language.enabled);
        toggle.setAttribute('aria-label', `Enable ${language.label}`);
        toggle.addEventListener('change', () => {
          const codes = new Set(enabledLanguageCodes());
          if (toggle.checked) codes.add(language.code);
          else codes.delete(language.code);
          codes.add('en');
          saveLanguageSettings({ enabledLanguages: [...codes] });
        });
        tdEnabled.appendChild(toggle);
      }

      const tdAvailable = document.createElement('td');
      const available = document.createElement('span');
      available.className = `verdict ${language.availableToStaff ? 'verdict-good' : 'verdict-review'}`;
      available.textContent = language.availableToStaff ? 'Yes' : 'No';
      tdAvailable.appendChild(available);
      if (!language.availableToStaff && !isEnglish) {
        const reason = document.createElement('div');
        reason.className = 'language-available-reason';
        reason.textContent = language.enabled ? 'no approved model for the bank default' : 'language is off';
        tdAvailable.appendChild(reason);
      }

      const tdApproved = document.createElement('td');
      const approvedFor = language.approvedFor || [];
      if (isEnglish) {
        tdApproved.textContent = 'English always';
      } else if (!approvedFor.length) {
        tdApproved.textContent = 'Not yet';
      } else {
        tdApproved.textContent = approvedFor.join(', ');
      }
      const caution = notApprovedCaution(language);
      if (caution) tdApproved.appendChild(caution);

      // Offering a language the model has not passed a test in is the bank's decision, not the
      // software's — but it has to be an explicit one, and it stays labelled as an override.
      if (!isEnglish) {
        const overrideLabel = document.createElement('label');
        overrideLabel.className = 'language-override-label';
        const override = document.createElement('input');
        override.type = 'checkbox';
        override.className = 'language-override-toggle';
        override.checked = Boolean(language.overridden);
        override.setAttribute('aria-label', `Offer ${language.label} to staff without a passed test`);
        override.addEventListener('change', () => {
          const codes = new Set((languageData.languages || []).filter((l) => l.overridden).map((l) => l.code));
          if (override.checked) codes.add(language.code);
          else codes.delete(language.code);
          saveLanguageSettings({ overrideLanguages: [...codes] });
        });
        const overrideText = document.createElement('span');
        overrideText.textContent = 'Offer to staff anyway';
        overrideLabel.append(override, overrideText);
        tdApproved.appendChild(overrideLabel);
        if (language.overridden && !language.availableToStaff && !approvedFor.length) {
          const note = document.createElement('div');
          note.className = 'language-available-reason';
          note.textContent = 'override on, but the language itself is switched off';
          tdApproved.appendChild(note);
        }
      }

      const tdTested = document.createElement('td');
      if (!language.lastTest) {
        tdTested.textContent = 'Never';
      } else {
        const badge = statusBadge(language.lastTest.status);
        badge.classList.add('language-last-test-badge');
        tdTested.appendChild(badge);
        const when = document.createElement('div');
        when.className = 'language-native-name';
        when.textContent = `${formatDate(language.lastTest.testedAt)} · ${language.lastTest.model}`;
        tdTested.appendChild(when);
      }

      tr.append(tdName, tdEnabled, tdAvailable, tdApproved, tdTested);
      tbody.appendChild(tr);
    }
  }

  defaultLanguageSelect.addEventListener('change', () => saveLanguageSettings({ defaultLanguage: defaultLanguageSelect.value }));
  languageChoiceToggle.addEventListener('change', () => saveLanguageSettings({ choiceAllowed: languageChoiceToggle.checked }));
  searchTranslationToggle.addEventListener('change', () =>
    saveLanguageSettings({ searchTranslation: searchTranslationToggle.checked })
  );
  // Turning the approval workflow on/off changes the meaning of every existing term, so confirm what
  // the server did rather than leaving the toggle to imply it.
  terminologyApprovalToggle.addEventListener('change', async () => {
    const wanted = terminologyApprovalToggle.checked;
    const saved = await saveLanguageSettings({ terminologyApproval: wanted });
    // A refused save has already put the toggle back and shown the server's message.
    if (saved) {
      showLanguageStatus(
        wanted
          ? 'Saved. New and edited terms now stay pending until an administrator approves them.'
          : 'Saved. Terms are given to the AI without approval while the workflow is off.'
      );
    }
  });

  // ---------- Block 2: capability testing ----------

  function renderCapabilityModelSelect() {
    const previous = capabilityModelSelect.value;
    capabilityModelSelect.innerHTML = '';
    const models = languageData.models || [];
    if (!models.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No models available';
      capabilityModelSelect.appendChild(opt);
      capabilityModelSelect.disabled = true;
      capabilityRunBtn.disabled = true;
      return;
    }
    capabilityModelSelect.disabled = false;
    capabilityRunBtn.disabled = false;
    for (const model of models) {
      const opt = document.createElement('option');
      opt.value = model.name;
      opt.textContent = capabilityModelLabel(model);
      capabilityModelSelect.appendChild(opt);
    }
    // Default to the bank's own model: that is the one whose approval decides what staff are offered.
    const preferred = [previous, languageData.bankDefaultModel].find((name) => name && models.some((m) => m.name === name));
    if (preferred) capabilityModelSelect.value = preferred;
    updateCapabilityExternalNote();
  }

  function updateCapabilityExternalNote() {
    const model = modelByCapabilityName(capabilityModelSelect.value);
    if (model?.external) {
      capabilityExternalNote.textContent = '☁ This model runs outside the bank’s machine.';
      capabilityExternalNote.classList.add('capability-external');
    } else {
      capabilityExternalNote.textContent = '';
      capabilityExternalNote.classList.remove('capability-external');
    }
  }
  capabilityModelSelect.addEventListener('change', updateCapabilityExternalNote);

  function renderCapabilityLanguageOptions() {
    const previous = new Set([...capabilityLanguageOptions.querySelectorAll('input:checked')].map((i) => i.value));
    capabilityLanguageOptions.innerHTML = '';
    // English needs no test — it is the bank's working language and the fallback — so it is never
    // offered here. Only enabled languages are worth testing; testing a disabled one proves nothing.
    const codes = enabledLanguageCodes().filter((code) => code !== 'en');
    if (!codes.length) {
      const hint = document.createElement('span');
      hint.className = 'language-available-reason';
      hint.textContent = 'No languages are enabled yet — enable one above first.';
      capabilityLanguageOptions.appendChild(hint);
      return;
    }
    for (const code of codes) {
      const label = document.createElement('label');
      label.className = 'capability-language';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.value = code;
      box.checked = previous.has(code);
      label.append(box, document.createTextNode(` ${languageLabel(code)}`));
      capabilityLanguageOptions.appendChild(label);
    }
  }

  // One row per language being tested, updated in place as `progress` events arrive. Rebuilding the
  // whole area on every event would make the labels flicker and lose the progress bars' animation.
  function startCapabilityProgress(model, languages) {
    capabilityProgress.classList.remove('hidden');
    capabilityProgress.innerHTML = '';
    const summary = document.createElement('div');
    summary.className = 'capability-progress-summary';
    summary.textContent = `Testing ${model} in ${languages.length} language${languages.length === 1 ? '' : 's'}…`;
    capabilityProgress.appendChild(summary);

    const rows = new Map();
    for (const code of languages) {
      const row = document.createElement('div');
      row.className = 'capability-progress-row';
      row.innerHTML = `
        <span class="capability-spinner" aria-hidden="true"></span>
        <span class="capability-progress-language">${escapeHtml(languageLabel(code))}</span>
        <span class="capability-progress-label">Starting…</span>
        <span class="capability-progress-track"><span class="capability-progress-bar"></span></span>
      `;
      capabilityProgress.appendChild(row);
      rows.set(code, {
        row,
        spinner: row.querySelector('.capability-spinner'),
        label: row.querySelector('.capability-progress-label'),
        bar: row.querySelector('.capability-progress-bar'),
      });
    }
    return { summary, rows };
  }

  function setCapabilityRowState(entry, { label, percent, status }) {
    if (!entry) return;
    if (label !== undefined) entry.label.textContent = label;
    if (percent !== undefined) entry.bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
    if (status === 'approved' || status === 'failed') {
      entry.spinner.classList.remove('capability-spinner');
      entry.spinner.classList.add('capability-status-icon');
      entry.spinner.textContent = status === 'approved' ? '✓' : '✕';
      entry.spinner.classList.add(status === 'approved' ? 'is-approved' : 'is-failed');
      entry.bar.classList.add(status === 'approved' ? 'is-approved' : 'is-failed');
      entry.bar.style.width = '100%';
      // Replace the last step's label with the verdict — once the language is done, the useful
      // information is the result, not which check happened to finish last.
      entry.label.textContent = status === 'approved' ? 'Approved' : 'Failed';
    } else if (status === 'stopped') {
      entry.spinner.classList.remove('capability-spinner');
      entry.spinner.classList.add('capability-status-icon', 'is-stopped');
      entry.spinner.textContent = '■';
      entry.label.textContent = 'Stopped';
      entry.bar.classList.add('is-stopped');
    }
  }

  function renderCapabilityResult(result) {
    const card = document.createElement('div');
    card.className = `capability-result ${result.status === 'approved' ? 'is-approved' : 'is-failed'}`;
    const header = document.createElement('div');
    header.className = 'capability-result-header';
    const title = document.createElement('h4');
    title.textContent = languageLabel(result.language);
    const badge = statusBadge(result.status);
    const score = document.createElement('span');
    score.className = 'capability-result-score';
    score.textContent = `${scorePercent(result.score)} of checks passed`;
    header.append(title, badge, score);
    card.appendChild(header);

    const list = document.createElement('ul');
    list.className = 'capability-check-list';
    for (const check of result.checks || []) {
      const li = document.createElement('li');
      li.className = `capability-check ${check.passed ? 'is-passed' : 'is-failed'}`;
      const mark = document.createElement('span');
      mark.className = 'capability-check-mark';
      mark.innerHTML = check.passed ? icon('check', { size: 14 }) : icon('x', { size: 14 });
      const text = document.createElement('span');
      const checkLabel = document.createElement('strong');
      checkLabel.textContent = check.label || check.key;
      text.append(checkLabel);
      if (check.detail) {
        const detail = document.createElement('span');
        detail.className = 'capability-check-detail';
        detail.textContent = ` — ${check.detail}`;
        text.appendChild(detail);
      }
      li.append(mark, text);
      list.appendChild(li);
    }
    card.appendChild(list);
    capabilityResultsEl.appendChild(card);
  }

  function setCapabilityRunButtons(running) {
    capabilityRunBtn.disabled = running;
    capabilityStopBtn.disabled = !running;
  }

  async function runCapabilityTest() {
    if (capabilityRun) return;
    hideError();
    const model = capabilityModelSelect.value;
    const languages = [...capabilityLanguageOptions.querySelectorAll('input:checked')].map((input) => input.value);
    if (!model) return showError('Choose a model to test.');
    if (!languages.length) return showError('Tick at least one language to test.');

    capabilityResultsEl.innerHTML = '';
    const progress = startCapabilityProgress(model, languages);
    const controller = new AbortController();
    capabilityRun = { controller, summary: progress.summary, rows: progress.rows, model };
    setCapabilityRunButtons(true);

    try {
      const res = await fetch('/api/admin/language/capabilities/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, languages }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Could not start the capability test');
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

          if (eventName === 'start') {
            progress.summary.textContent = `Testing ${data.model || model} in ${(data.languages || languages).length} language(s)…`;
          } else if (eventName === 'progress') {
            setCapabilityRowState(progress.rows.get(data.language), {
              label: `${data.label || data.step || 'Testing'} (${data.index}/${data.total})`,
              percent: data.total ? (data.index / data.total) * 100 : 0,
            });
          } else if (eventName === 'result') {
            setCapabilityRowState(progress.rows.get(data.language), { status: data.status });
            renderCapabilityResult(data);
          } else if (eventName === 'done') {
            const resultCount = (data.results || []).length;
            progress.summary.textContent = `Finished — ${resultCount} language${resultCount === 1 ? '' : 's'} tested.`;
          } else if (eventName === 'error') {
            showError(data.error || 'The capability test failed');
            progress.summary.textContent = 'The test failed — see the message above.';
          }
        }
      }
    } catch (err) {
      // An abort is a deliberate Stop, not a failure: say so plainly, and leave any language that had
      // already finished showing its saved result.
      if (err.name === 'AbortError') {
        progress.summary.textContent = 'Test stopped — results already finished were saved; the rest were not.';
        for (const entry of progress.rows.values()) {
          if (!entry.spinner.classList.contains('capability-status-icon')) setCapabilityRowState(entry, { status: 'stopped' });
        }
      } else {
        progress.summary.textContent = 'The test failed — see the message above.';
        showError(err.message || 'The capability test failed');
      }
    } finally {
      capabilityRun = null;
      setCapabilityRunButtons(false);
      // Whatever happened, re-read the approvals and the history: finished languages are recorded even
      // when a later one was stopped.
      await loadLanguageSettings();
      await loadCapabilityHistory();
    }
  }

  function stopCapabilityTest() {
    if (!capabilityRun) return;
    capabilityStopBtn.disabled = true;
    capabilityRun.controller.abort();
  }

  capabilityRunBtn.addEventListener('click', runCapabilityTest);
  capabilityStopBtn.addEventListener('click', stopCapabilityTest);

  async function loadCapabilityHistory() {
    const res = await fetch('/api/admin/language/capabilities');
    const data = await res.json().catch(() => ({}));
    const tbody = document.getElementById('capability-history-tbody');
    tbody.innerHTML = '';
    if (!res.ok) return renderEmptyRow(tbody, 6, data.error || 'Could not load past tests.');
    // The models a test can run against come from here (installed local ones plus enabled external
    // ones), so the capability model picker is (re)filled from this response rather than a fixed list.
    if (languageData) {
      languageData.models = data.models || [];
      if (data.bankDefaultModel) languageData.bankDefaultModel = data.bankDefaultModel;
      renderCapabilityModelSelect();
    }
    if (!data.tests || !data.tests.length) return renderEmptyRow(tbody, 6, 'No capability tests have been run yet.');
    for (const test of data.tests) {
      const tr = document.createElement('tr');
      const cells = [test.model, languageLabel(test.language), null, scorePercent(test.score), formatDate(test.testedAt), test.testedBy || '—'];
      for (const text of cells) {
        const td = document.createElement('td');
        if (text === null) td.appendChild(statusBadge(test.status));
        else td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  // ---------- Block 3: bank wording (terminology) ----------

  // The terms table is server-side: it owns search (English term, approved wording or context), the
  // 60-character limit, the 200-term cap and the approval workflow, so every add/edit/approve re-reads
  // the list rather than trying to keep a local copy in step. Only terms the server says are approved
  // are given to the model when the workflow is on — the status badge is what tells an admin that.

  function termsColspan() {
    return termsMeta.approvalRequired ? 6 : 5;
  }

  function termStatusLabel(status) {
    if (status === 'pending') return 'Pending approval';
    if (status === 'rejected') return 'Rejected';
    return 'Approved';
  }

  function makeTermBadge(status) {
    const span = document.createElement('span');
    const value = status === 'pending' || status === 'rejected' ? status : 'approved';
    span.className = `term-badge ${value}`;
    span.textContent = termStatusLabel(value);
    return span;
  }

  function makeTermMetaCell(term) {
    const td = document.createElement('td');
    const added = document.createElement('span');
    added.className = 'term-meta';
    added.textContent = `Added by ${term.createdBy || '—'}${term.createdAt ? ` · ${formatDate(term.createdAt)}` : ''}`;
    td.appendChild(added);
    if (term.updatedBy || term.updatedAt) {
      const edited = document.createElement('span');
      edited.className = 'term-meta';
      edited.textContent = `Edited by ${term.updatedBy || '—'}${term.updatedAt ? ` · ${formatDate(term.updatedAt)}` : ''}`;
      td.appendChild(edited);
    }
    return td;
  }

  function makeTermInput(value, ariaLabel) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'term-edit-input';
    input.maxLength = termsMeta.limits.maxLength || 60;
    input.value = value || '';
    input.setAttribute('aria-label', ariaLabel);
    return input;
  }

  function makeTermAction(text, className, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className || 'table-btn';
    btn.textContent = text;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderTermsLanguageSelect() {
    const previous = termsLanguageSelect.value;
    termsLanguageSelect.innerHTML = '';
    const codes = enabledLanguageCodes().filter((code) => code !== 'en');
    if (!codes.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'No languages enabled';
      termsLanguageSelect.appendChild(opt);
      termsLanguageSelect.disabled = true;
      return;
    }
    termsLanguageSelect.disabled = false;
    for (const code of codes) {
      const opt = document.createElement('option');
      opt.value = code;
      opt.textContent = languageLabel(code);
      termsLanguageSelect.appendChild(opt);
    }
    if (previous && codes.includes(previous)) termsLanguageSelect.value = previous;
  }

  async function loadTerms() {
    const language = termsLanguageSelect.value;
    if (!language) {
      termsTbody.innerHTML = '';
      termsHint.textContent = '';
      return renderEmptyRow(termsTbody, 5, 'Enable a language above to record its bank wording.');
    }
    const params = new URLSearchParams({ language });
    const q = termsSearchInput.value.trim();
    if (q) params.set('q', q);
    const res = await fetch(`/api/admin/language/terms?${params}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || 'Could not load terminology');
    // The terms endpoint is the authority on the workflow, the limits and the per-language counts.
    termsMeta = {
      approvalRequired: data.approvalRequired === true,
      limits: data.limits && typeof data.limits === 'object' ? data.limits : { maxTerms: 200, maxLength: 60 },
      counts: data.counts && typeof data.counts === 'object' ? data.counts : {},
    };
    renderTermsTable(data.terms || [], language);
  }

  function renderTermsTable(terms, language) {
    termsTbody.innerHTML = '';
    const maxTerms = Number(termsMeta.limits.maxTerms) || 200;
    const maxLength = Number(termsMeta.limits.maxLength) || 60;
    const count = Number.isFinite(Number(termsMeta.counts[language])) ? Number(termsMeta.counts[language]) : terms.length;
    for (const input of [termsEnInput, termsLocalInput, termsContextInput]) input.maxLength = maxLength;
    termsStatusTh.classList.toggle('hidden', !termsMeta.approvalRequired);
    const searching = Boolean(termsSearchInput.value.trim());
    termsHint.textContent = `${count} of ${maxTerms} terms in ${languageLabel(language)}${
      searching ? ' shown for this search' : ''
    } · maximum ${maxLength} characters per field.`;
    if (!terms.length) {
      return renderEmptyRow(
        termsTbody,
        termsColspan(),
        searching
          ? 'No terms match that search.'
          : `No ${languageLabel(language)} terms yet — answers will be in the language, just without a preferred bank wording.`
      );
    }
    for (const term of terms) {
      termsTbody.appendChild(renderTermRow(term, language));
    }
  }

  function renderTermRow(term, language) {
    const tr = document.createElement('tr');
    tr.className = 'term-row';
    // A pending or rejected term is not bank-approved wording, so the row must not look like it is.
    const unapproved = termsMeta.approvalRequired && term.status && term.status !== 'approved';
    if (unapproved) tr.classList.add('is-unapproved');

    const tdEnglish = document.createElement('td');
    tdEnglish.textContent = term.englishTerm;
    const tdLocal = document.createElement('td');
    tdLocal.textContent = term.localTerm;
    const tdContext = document.createElement('td');
    const context = document.createElement('span');
    context.className = 'term-context';
    context.textContent = term.context || '—';
    if (term.context) context.title = term.context;
    tdContext.appendChild(context);
    const tdStatus = document.createElement('td');
    if (termsMeta.approvalRequired) tdStatus.appendChild(makeTermBadge(term.status));
    else tdStatus.className = 'hidden';

    const tdActions = document.createElement('td');
    tdActions.className = 'admin-doc-actions';

    tdActions.appendChild(makeTermAction('Edit', 'table-btn', () => startEditTerm(tr, term, language)));
    tdActions.appendChild(
      makeTermAction('Delete', 'table-btn danger', async () => {
        if (!confirm(`Delete the wording for "${term.englishTerm}" in ${languageLabel(language)}?`)) return;
        hideError();
        const res = await fetch(`/api/admin/language/terms/${term.id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return showError(data.error || 'Could not delete the term');
        showLanguageStatus(`Deleted "${term.englishTerm}".`);
        await loadTerms();
      })
    );
    if (termsMeta.approvalRequired) {
      if (term.status !== 'approved') {
        tdActions.appendChild(
          makeTermAction('Approve', 'table-btn', async () => {
            hideError();
            const res = await fetch(`/api/admin/language/terms/${term.id}/approve`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return showError(data.error || 'Could not approve the term');
            showLanguageStatus(`Approved "${term.englishTerm}" — it is now given to the AI.`);
            await loadTerms();
          })
        );
      } else {
        tdActions.appendChild(
          makeTermAction('Reject', 'table-btn danger', async () => {
            hideError();
            const res = await fetch(`/api/admin/language/terms/${term.id}/reject`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) return showError(data.error || 'Could not reject the term');
            showLanguageStatus(`Rejected "${term.englishTerm}" — it is no longer given to the AI.`);
            await loadTerms();
          })
        );
      }
    }

    tr.append(tdEnglish, tdLocal, tdContext, tdStatus, makeTermMetaCell(term), tdActions);
    return tr;
  }

  // Edit in place: the row becomes three inputs with Save/Cancel, so correcting wording never means
  // retyping the English term. An edit goes back for approval when the workflow is on (the server
  // decides that; the row is re-read afterwards so its new status is shown truthfully).
  function startEditTerm(tr, term, language) {
    const englishInput = makeTermInput(term.englishTerm, 'English term');
    const localInput = makeTermInput(term.localTerm, 'Approved wording');
    const contextInput = makeTermInput(term.context || '', 'Context (optional)');

    const tdEnglish = document.createElement('td');
    tdEnglish.appendChild(englishInput);
    const tdLocal = document.createElement('td');
    tdLocal.appendChild(localInput);
    const tdContext = document.createElement('td');
    tdContext.appendChild(contextInput);
    const tdStatus = document.createElement('td');
    if (termsMeta.approvalRequired) tdStatus.appendChild(makeTermBadge(term.status));
    else tdStatus.className = 'hidden';

    const tdActions = document.createElement('td');
    tdActions.className = 'admin-doc-actions';

    const saveBtn = makeTermAction('Save', 'table-btn', async () => {
      const englishTerm = englishInput.value.trim();
      const localTerm = localInput.value.trim();
      const context = contextInput.value.trim();
      if (!englishTerm || !localTerm) return showError('Both the English term and the approved wording are required.');
      hideError();
      saveBtn.disabled = true;
      const res = await fetch(`/api/admin/language/terms/${term.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ englishTerm, localTerm, context }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        saveBtn.disabled = false;
        // The server's own message (duplicate, too long, limit reached) is more precise than ours.
        return showError(data.error || 'Could not save the term');
      }
      showLanguageStatus(
        termsMeta.approvalRequired && data.term && data.term.status === 'pending'
          ? `Saved "${englishTerm}" — pending approval before it is given to the AI.`
          : `Saved "${englishTerm}".`
      );
      await loadTerms();
    });
    const cancelBtn = makeTermAction('Cancel', 'table-btn', () => loadTerms());

    tdActions.append(saveBtn, cancelBtn);
    tr.innerHTML = '';
    tr.append(tdEnglish, tdLocal, tdContext, tdStatus, makeTermMetaCell(term), tdActions);
    englishInput.focus();
  }

  async function addTerm() {
    hideError();
    const language = termsLanguageSelect.value;
    const englishTerm = termsEnInput.value.trim();
    const localTerm = termsLocalInput.value.trim();
    const context = termsContextInput.value.trim();
    if (!language) return showError('Enable a language before adding bank wording.');
    if (!englishTerm || !localTerm) return showError('Enter both the English term and the approved wording.');
    // Limits, duplicates and the approval rule are the server's to decide, and its message is the one
    // shown (verbatim) — checking here would risk hiding a clearer explanation behind a vaguer one.
    const res = await fetch('/api/admin/language/terms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language, englishTerm, localTerm, context }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return showError(data.error || 'Could not add the term');
    termsEnInput.value = '';
    termsLocalInput.value = '';
    termsContextInput.value = '';
    termsEnInput.focus();
    showLanguageStatus(
      termsMeta.approvalRequired && data.term && data.term.status === 'pending'
        ? `Added "${englishTerm}" — pending approval before it is given to the AI.`
        : `Added "${englishTerm}".`
    );
    await loadTerms();
  }

  termsLanguageSelect.addEventListener('change', loadTerms);
  document.getElementById('terms-add-btn').addEventListener('click', addTerm);
  for (const input of [termsEnInput, termsLocalInput, termsContextInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addTerm();
    });
  }
  termsSearchInput.addEventListener('input', () => {
    clearTimeout(termsSearchTimer);
    termsSearchTimer = setTimeout(loadTerms, 250);
  });

  // ---------- Block 4: usage & quality ----------
  //
  // The server aggregates answers, the automatic garble flag and the three staff feedback categories,
  // and returns the same events the Operations tab shows — but structured and with no message text
  // (data protection), which is what makes "is this recurring for this model?" answerable here.

  function formatFilterDate(value) {
    if (!value) return '—';
    const d = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function formatPercent(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(1)}%`;
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    const base = String(value).includes('T') ? String(value) : String(value).replace(' ', 'T');
    const d = new Date(base.includes('Z') || base.includes('+') ? base : `${base}Z`);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
  }

  const REASON_LABELS = {
    unreliable: 'Garbled / unreliable',
    garbled: 'Garbled',
    incorrect: 'Incorrect translation',
    unclear: 'Hard to understand',
    wrong_language: 'Not in the requested language',
    not_translated: 'Not translated',
  };

  function reasonLabel(reason) {
    if (!reason) return '—';
    return REASON_LABELS[reason] || String(reason).replace(/_/g, ' ');
  }

  // The language and provider/model filter options come from the server, so a language or model that
  // exists is always selectable; the current filter is kept even if it is not in the options list.
  function setFilterOptions(select, allLabel, items, current) {
    select.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = allLabel;
    select.appendChild(all);
    const seen = new Set(['']);
    for (const item of items) {
      if (seen.has(item.value)) continue;
      seen.add(item.value);
      const opt = document.createElement('option');
      opt.value = item.value;
      opt.textContent = item.label;
      select.appendChild(opt);
    }
    if (current && !seen.has(current)) {
      const opt = document.createElement('option');
      opt.value = current;
      opt.textContent = current;
      select.appendChild(opt);
    }
    select.value = current || '';
  }

  function renderStatsFilterOptions(options) {
    const languages = (options && options.languages) || [];
    const providers = (options && options.providers) || [];
    const models = (options && options.models) || [];
    setFilterOptions(
      languageFilterLanguage,
      'All languages',
      languages.map((l) => ({ value: l.code, label: l.label })),
      languageStatsFilters.language
    );
    setFilterOptions(
      languageFilterProvider,
      'All providers',
      providers.map((p) => ({ value: p, label: p === 'local' ? 'Local' : `☁ ${p}` })),
      languageStatsFilters.provider
    );
    setFilterOptions(
      languageFilterModel,
      'All models',
      models.map((m) => ({ value: m, label: m })),
      languageStatsFilters.model
    );
  }

  function statsParams() {
    const params = new URLSearchParams();
    for (const key of ['from', 'to', 'language', 'provider', 'model']) {
      if (languageStatsFilters[key]) params.set(key, languageStatsFilters[key]);
    }
    return params;
  }

  function eventsParams() {
    const params = new URLSearchParams();
    for (const key of ['from', 'to', 'language', 'model']) {
      if (languageStatsFilters[key]) params.set(key, languageStatsFilters[key]);
    }
    params.set('limit', '100');
    return params;
  }

  function renderStatsCards(totals) {
    languageStatsEl.innerHTML = '';
    const t = totals || {};
    const cards = [
      ['Total answers', t.answers, null],
      ['Garbled (auto-flagged)', t.garbled, 'is-flagged'],
      ['Incorrect translations (staff)', t.incorrect, 'is-flagged'],
      ['Hard to understand (staff)', t.unclear, 'is-flagged'],
      ['Good translations (staff)', t.good, null],
    ];
    for (const [label, value, cls] of cards) {
      const card = statCard(label, Number(value) || 0);
      if (cls) card.classList.add(cls);
      languageStatsEl.appendChild(card);
    }
  }

  function renderStatsRange(filters) {
    const echoed = filters || {};
    const parts = [];
    if (echoed.from || echoed.to) {
      const from = echoed.from ? formatFilterDate(echoed.from) : 'the beginning';
      const to = echoed.to ? formatFilterDate(echoed.to) : 'today';
      parts.push(`Showing ${from} to ${to}`);
    } else {
      parts.push('No date range chosen — showing the last 14 days');
    }
    if (echoed.language) parts.push(`language: ${languageLabel(echoed.language)}`);
    if (echoed.provider) parts.push(`provider: ${echoed.provider === 'local' ? 'local' : `☁ ${echoed.provider}`}`);
    if (echoed.model) parts.push(`model: ${echoed.model}`);
    languageStatsRange.textContent = `${parts.join(' · ')}.`;
  }

  function renderByLanguageTable(rows) {
    languageUsageTbody.innerHTML = '';
    if (!rows.length) return renderEmptyRow(languageUsageTbody, 7, 'No answers in this period.');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const cells = [
        row.label || languageLabel(row.language),
        row.answers || 0,
        formatPercent(row.percent),
        row.garbled || 0,
        row.incorrect || 0,
        row.unclear || 0,
        row.good || 0,
      ];
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      languageUsageTbody.appendChild(tr);
    }
  }

  function renderByModelTable(rows) {
    languageModelTbody.innerHTML = '';
    if (!rows.length) return renderEmptyRow(languageModelTbody, 6, 'No answers in this period.');
    for (const row of rows) {
      const tr = document.createElement('tr');
      const modelCell = document.createElement('td');
      modelCell.textContent = row.model || '—';
      const providerCell = document.createElement('td');
      // Local models keep everything on the bank's machine; external ones are marked ☁, as everywhere.
      providerCell.textContent = row.provider === 'local' ? 'Local' : row.provider ? `☁ ${row.provider}` : '—';
      const tdAnswers = document.createElement('td');
      tdAnswers.textContent = row.answers || 0;
      const tdGarbled = document.createElement('td');
      tdGarbled.textContent = row.garbled || 0;
      const tdIncorrect = document.createElement('td');
      tdIncorrect.textContent = row.incorrect || 0;
      const tdUnclear = document.createElement('td');
      tdUnclear.textContent = row.unclear || 0;
      tr.append(modelCell, providerCell, tdAnswers, tdGarbled, tdIncorrect, tdUnclear);
      languageModelTbody.appendChild(tr);
    }
  }

  function renderTrend(trend, limitToLast14) {
    languageTrendChart.innerHTML = '';
    languageTrendTbody.innerHTML = '';
    let days = Array.isArray(trend) ? trend : [];
    // With no date range chosen the panel is a rolling two-week view, as the hint above it promises.
    if (limitToLast14) days = days.slice(-14);
    if (!days.length) {
      const empty = document.createElement('div');
      empty.className = 'language-trend-empty';
      empty.textContent = 'No answers in this period.';
      languageTrendChart.appendChild(empty);
      return renderEmptyRow(languageTrendTbody, 4, 'No daily figures in this period.');
    }

    const max = Math.max(1, ...days.map((day) => Number(day.answers) || 0));
    for (const day of days) {
      const answers = Number(day.answers) || 0;
      const garbled = Number(day.garbled) || 0;
      const incorrect = Number(day.incorrect) || 0;
      const unclear = Number(day.unclear) || 0;

      const col = document.createElement('div');
      col.className = 'language-trend-col';
      col.title = `${formatFilterDate(day.date)}: ${answers} answer${answers === 1 ? '' : 's'}, ${garbled} garbled, ${incorrect} incorrect, ${unclear} unclear`;
      const plot = document.createElement('div');
      plot.className = 'language-trend-plot';
      const bar = document.createElement('div');
      bar.className = 'language-trend-bar';
      // The bar's total height shows the day's volume; the flagged portion is coloured in proportion
      // to that day's answers, so a single garble on a quiet day still stands out.
      bar.style.height = answers ? `${Math.max(3, Math.round((answers / max) * 100))}%` : '2px';
      // Appended bottom-up: unclear on top, then incorrect, then garbled at the base.
      for (const [count, cls] of [
        [unclear, 'unclear'],
        [incorrect, 'incorrect'],
        [garbled, 'garbled'],
      ]) {
        if (!count) continue;
        const seg = document.createElement('div');
        seg.className = `language-trend-seg ${cls}`;
        seg.style.height = `${Math.min(100, (count / answers) * 100)}%`;
        bar.appendChild(seg);
      }
      plot.appendChild(bar);
      const label = document.createElement('span');
      label.className = 'language-trend-day';
      label.textContent = day.date ? String(day.date).slice(-2) : '—';
      col.append(plot, label);
      languageTrendChart.appendChild(col);
    }

    // The compact table repeats the last days in text, most recent first, for anyone who needs exact
    // numbers rather than a shape.
    const recent = days.slice(-14).reverse();
    for (const day of recent) {
      const tr = document.createElement('tr');
      for (const text of [formatFilterDate(day.date), day.answers || 0, day.garbled || 0, day.incorrect || 0]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      languageTrendTbody.appendChild(tr);
    }
  }

  function renderEventsSummary(summary) {
    languageEventsSummary.innerHTML = '';
    if (!summary.length) {
      const span = document.createElement('span');
      span.className = 'admin-panel-hint hint-tight';
      span.textContent = 'No quality warnings in this period.';
      languageEventsSummary.appendChild(span);
      return;
    }
    for (const row of summary) {
      const chip = document.createElement('span');
      chip.className = 'language-events-reason';
      const count = document.createElement('strong');
      count.textContent = String(row.count || 0);
      chip.append(count, document.createTextNode(` ${reasonLabel(row.reason)}`));
      languageEventsSummary.appendChild(chip);
    }
  }

  function renderEventsRecurring(recurring) {
    languageEventsRecurring.innerHTML = '';
    if (!recurring.length) {
      const none = document.createElement('div');
      none.className = 'language-events-recurring-item is-none';
      none.textContent = 'No recurring pattern — no model repeated warnings in this period.';
      languageEventsRecurring.appendChild(none);
      return;
    }
    for (const row of recurring) {
      const item = document.createElement('div');
      item.className = 'language-events-recurring-item';
      const model = document.createElement('strong');
      model.textContent = row.model || 'unknown model';
      const count = Number(row.count) || 0;
      item.append(
        document.createTextNode('reliably recurring: '),
        model,
        document.createTextNode(` · ${languageLabel(row.language)} · ${count} warning${count === 1 ? '' : 's'}`)
      );
      languageEventsRecurring.appendChild(item);
    }
  }

  function renderLanguageEvents(data) {
    const events = Array.isArray(data.events) ? data.events : [];
    renderEventsSummary(Array.isArray(data.summary) ? data.summary : []);
    renderEventsRecurring(Array.isArray(data.recurring) ? data.recurring : []);

    languageEventsTbody.innerHTML = '';
    if (!events.length) return renderEmptyRow(languageEventsTbody, 5, 'No warnings in this period.');
    for (const event of events) {
      const tr = document.createElement('tr');
      const reference = event.conversationId
        ? `Conversation #${event.conversationId}${event.messageId ? ` · message #${event.messageId}` : ''}`
        : '—';
      for (const text of [
        formatTimestamp(event.at),
        languageLabel(event.language),
        event.model || '—',
        reasonLabel(event.reason),
        reference,
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      languageEventsTbody.appendChild(tr);
    }
  }

  function showStatsError(element, message) {
    element.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'admin-panel-hint hint-tight';
    p.textContent = message;
    element.appendChild(p);
  }

  async function loadLanguageStats() {
    const seq = ++languageStatsSeq;
    const statsRes = await fetch(`/api/admin/language/stats?${statsParams()}`);
    const stats = await statsRes.json().catch(() => ({}));
    const eventsRes = await fetch(`/api/admin/language/events?${eventsParams()}`);
    const events = await eventsRes.json().catch(() => ({}));
    // A second Apply clicked while this was in flight wins; its response must not be overwritten.
    if (seq !== languageStatsSeq) return;

    if (!statsRes.ok) {
      showError(stats.error || 'Could not load language usage stats.');
      showStatsError(languageStatsEl, stats.error || 'Could not load language usage stats.');
    } else {
      const echoed = stats.filters && typeof stats.filters === 'object' ? stats.filters : languageStatsFilters;
      renderStatsFilterOptions(stats.options);
      renderStatsRange(echoed);
      renderStatsCards(stats.totals);
      renderByLanguageTable(Array.isArray(stats.byLanguage) ? stats.byLanguage : []);
      renderByModelTable(Array.isArray(stats.byModel) ? stats.byModel : []);
      renderTrend(Array.isArray(stats.trend) ? stats.trend : [], !echoed.from && !echoed.to);
    }

    if (!eventsRes.ok) {
      languageEventsSummary.innerHTML = '';
      languageEventsRecurring.innerHTML = '';
      showStatsError(languageEventsSummary, events.error || 'Could not load warnings.');
      renderEmptyRow(languageEventsTbody, 5, events.error || 'Could not load warnings.');
    } else {
      renderLanguageEvents(events);
    }
  }

  function readStatsFilters() {
    return {
      from: languageFromInput.value,
      to: languageToInput.value,
      language: languageFilterLanguage.value,
      provider: languageFilterProvider.value,
      model: languageFilterModel.value,
    };
  }

  document.getElementById('language-stats-apply').addEventListener('click', () => {
    hideError();
    languageStatsFilters = readStatsFilters();
    loadLanguageStats();
  });

  document.getElementById('language-stats-clear').addEventListener('click', () => {
    hideError();
    for (const input of [languageFromInput, languageToInput]) input.value = '';
    for (const select of [languageFilterLanguage, languageFilterProvider, languageFilterModel]) select.value = '';
    languageStatsFilters = { from: '', to: '', language: '', provider: '', model: '' };
    loadLanguageStats();
  });

  // Enter inside the date boxes applies, matching the rest of the admin portal's filter bars.
  for (const input of [languageFromInput, languageToInput]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        languageStatsFilters = readStatsFilters();
        loadLanguageStats();
      }
    });
  }

  bootstrap();
})();
