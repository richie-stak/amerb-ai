(function () {
  AmerbTheme.wireThemeToggle(document.getElementById('theme-toggle-btn'));

  const adminShell = document.getElementById('admin-shell');
  const adminError = document.getElementById('admin-error');
  const tabs = document.querySelectorAll('.admin-tab');
  const panels = {
    users: document.getElementById('panel-users'),
    models: document.getElementById('panel-models'),
    documents: document.getElementById('panel-documents'),
    tools: document.getElementById('panel-tools'),
    analytics: document.getElementById('panel-analytics'),
    system: document.getElementById('panel-system'),
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
    await Promise.all([loadUsers(), loadDocuments(), loadDomains(), loadSettings()]);
  }

  function selectTab(name) {
    for (const tab of tabs) {
      tab.classList.toggle('active', tab.dataset.tab === name);
    }
    for (const [key, el] of Object.entries(panels)) {
      el.classList.toggle('hidden', key !== name);
    }
    if (name === 'analytics') loadAnalytics();
  }

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

  // ---------- Documents ----------

  async function loadDocuments() {
    const res = await fetch('/api/documents');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load documents');
    renderDocuments(data.documents);
  }

  function renderDocuments(documents) {
    const tbody = document.getElementById('documents-tbody');
    tbody.innerHTML = '';

    if (!documents.length) return renderEmptyRow(tbody, 6, 'No documents uploaded yet.');

    for (const d of documents) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = d.filename;

      const tdDept = document.createElement('td');
      tdDept.textContent = d.department;

      const tdUploader = document.createElement('td');
      tdUploader.textContent = d.uploaded_by;

      const tdSize = document.createElement('td');
      tdSize.textContent = `${d.char_count.toLocaleString()} chars`;

      const tdAdded = document.createElement('td');
      tdAdded.textContent = formatDate(d.created_at);

      const tdActions = document.createElement('td');
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'table-btn danger';
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', async () => {
        if (!confirm(`Delete "${d.filename}" from the knowledge base?`)) return;
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
