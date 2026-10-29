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
    analytics: document.getElementById('panel-analytics'),
    system: document.getElementById('panel-system'),
    audit: document.getElementById('panel-audit'),
  };

  let departments = [];

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
    if (!meRes.ok || meData.user.role !== 'admin') {
      window.location.href = '/';
      return;
    }

    adminShell.classList.remove('hidden');

    for (const tab of tabs) {
      tab.addEventListener('click', () => selectTab(tab.dataset.tab));
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
    if (name === 'analytics') loadAnalytics();
    if (name === 'audit') loadAudit();
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

      const roleToggleBtn = document.createElement('button');
      roleToggleBtn.className = 'table-btn';
      roleToggleBtn.textContent = u.role === 'admin' ? 'Remove admin' : 'Make admin';
      roleToggleBtn.addEventListener('click', async () => {
        const newRole = u.role === 'admin' ? 'user' : 'admin';
        const res = await fetch(`/api/admin/users/${u.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        const data = await res.json();
        if (!res.ok) return showError(data.error || 'Could not update role');
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
      const badge = document.createElement('span');
      badge.className = `role-badge ${u.role}`;
      badge.textContent = u.role;
      tdRole.appendChild(badge);

      const tdJoined = document.createElement('td');
      tdJoined.textContent = formatDate(u.created_at);

      const tdActions = document.createElement('td');
      tdActions.appendChild(roleToggleBtn);
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

      const tdDept = document.createElement('td');
      tdDept.textContent = knowledgeBaseLabel(d);

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

      tr.append(tdName, tdDept, tdUploader, tdSize, tdAdded, tdActions);
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

  bootstrap();
})();
