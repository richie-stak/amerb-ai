(function () {
  AmerbTheme.wireThemeToggle(document.getElementById('theme-toggle-btn'));

  const kbShell = document.getElementById('kb-shell');
  const kbError = document.getElementById('kb-error');
  const kbTitle = document.getElementById('kb-title');
  const kbSubtitle = document.getElementById('kb-subtitle');
  const kbFolders = document.getElementById('kb-folders');
  const kbNoDepartment = document.getElementById('kb-no-department');
  const uploadBtn = document.getElementById('kb-upload-btn');
  const fileInput = document.getElementById('kb-file-input');
  const deptFilter = document.getElementById('kb-department-filter');
  const bankwideToggle = document.getElementById('kb-bankwide-toggle');
  const bankwideCheckbox = document.getElementById('kb-bankwide-checkbox');
  const bankwideSection = document.getElementById('kb-bankwide-section');
  const bankwideCount = document.getElementById('kb-bankwide-count');
  const bankwideList = document.getElementById('kb-bankwide-list');
  const BANKWIDE_DEPARTMENT = 'Bank-wide';
  const DOC_ICONS = { docx: 'fileText', pdf: 'fileText', xlsx: 'fileSpreadsheet', pptx: 'presentation', text: 'fileText', webpage: 'globe' };

  let currentUser = null;
  let allDocuments = [];

  function showError(msg) {
    kbError.textContent = msg;
    kbError.classList.remove('hidden');
  }

  function hideError() {
    kbError.classList.add('hidden');
  }

  function formatDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso.includes('Z') || iso.includes('+') ? iso : `${iso}Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  async function bootstrap() {
    const sessionRes = await fetch('/api/session');
    const sessionData = await sessionRes.json();
    if (!sessionData.authenticated) {
      window.location.href = '/login.html';
      return;
    }

    const meRes = await fetch('/api/auth/me');
    const meData = await meRes.json();
    currentUser = meData.user;
    kbShell.classList.remove('hidden');

    if (currentUser.role === 'admin') {
      kbTitle.textContent = 'Knowledge base — all departments';
      kbSubtitle.textContent = 'Every document uploaded across the bank, grouped by department.';
      deptFilter.classList.remove('hidden');
      deptFilter.addEventListener('change', renderFolders);
      bankwideToggle.classList.remove('hidden');
    } else {
      kbTitle.textContent = `Knowledge base — ${currentUser.department || 'no department'}`;
      kbSubtitle.textContent = "Documents your department has uploaded. Ask about them anytime in chat — you don't need to re-attach them.";
    }

    if (currentUser.role !== 'admin' && !currentUser.department) {
      kbNoDepartment.classList.remove('hidden');
      uploadBtn.disabled = true;
    } else {
      uploadBtn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files.length) uploadFiles(Array.from(fileInput.files));
        fileInput.value = '';
      });
    }

    await loadDocuments();
  }

  async function loadDocuments() {
    hideError();
    const res = await fetch('/api/documents');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load the knowledge base');
    allDocuments = data.documents;

    if (currentUser.role === 'admin') {
      const depts = [...new Set(allDocuments.map((d) => d.department))]
        .filter((d) => d !== BANKWIDE_DEPARTMENT)
        .sort();
      deptFilter.innerHTML = '<option value="">All departments</option>';
      for (const d of depts) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        deptFilter.appendChild(opt);
      }
    }

    renderBankwideSection();
    renderFolders();
  }

  // The bank-wide section is deliberately kept separate from the per-department folders below —
  // it's not "another department", it's visible to every user regardless of their own department,
  // so folding it into the department list (or behind the department filter) would bury it for
  // exactly the people it's meant for.
  function renderBankwideSection() {
    const docs = allDocuments.filter((d) => d.department === BANKWIDE_DEPARTMENT);
    bankwideList.innerHTML = '';
    if (!docs.length) {
      bankwideSection.classList.add('hidden');
      return;
    }
    bankwideSection.classList.remove('hidden');
    bankwideCount.textContent = `${docs.length} file${docs.length === 1 ? '' : 's'}`;
    for (const doc of docs) {
      bankwideList.appendChild(renderDocRow(doc));
    }
  }

  function renderDocRow(doc) {
    const row = document.createElement('div');
    row.className = 'kb-file-row';

    const canDelete = currentUser.role === 'admin' || doc.uploaded_by === currentUser.username;
    const iconHtml = doc.kind === 'image'
      ? `<img class="chip-thumb kb-row-thumb" src="/api/documents/${doc.id}/image" alt="">`
      : `<span class="file-icon">${icon(DOC_ICONS[doc.kind] || 'fileText', { size: 17 })}</span>`;
    const sizeLabel = doc.kind === 'image'
      ? (doc.char_count ? `${doc.char_count.toLocaleString()} OCR'd chars` : 'image, no OCR text found')
      : `${doc.char_count.toLocaleString()} chars`;

    row.innerHTML = `
      ${iconHtml}
      <span class="file-name">${escapeHtml(doc.filename)}</span>
      <span class="file-meta">${sizeLabel} · ${escapeHtml(doc.uploaded_by)} · ${formatDate(doc.created_at)}</span>
    `;

    const downloadLink = document.createElement('a');
    downloadLink.className = 'table-btn';
    downloadLink.href = `/api/documents/${doc.id}/file?download=1`;
    downloadLink.title = 'Download';
    downloadLink.innerHTML = icon('download', { size: 13 });
    row.appendChild(downloadLink);

    if (canDelete) {
      const delBtn = document.createElement('button');
      delBtn.className = 'table-btn danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteDocument(doc.id));
      row.appendChild(delBtn);
    }

    return row;
  }

  function renderFolders() {
    kbFolders.innerHTML = '';

    const filter = currentUser.role === 'admin' ? deptFilter.value : currentUser.department;
    const grouped = new Map();
    for (const doc of allDocuments) {
      if (doc.department === BANKWIDE_DEPARTMENT) continue;
      if (filter && doc.department !== filter) continue;
      if (!grouped.has(doc.department)) grouped.set(doc.department, []);
      grouped.get(doc.department).push(doc);
    }

    if (!grouped.size) {
      const empty = document.createElement('div');
      empty.className = 'kb-empty';
      empty.innerHTML = `${icon('inbox', { size: 26 })}<span>No documents yet. Use "Add files" above to upload the first one.</span>`;
      kbFolders.appendChild(empty);
      return;
    }

    for (const [department, docs] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const folder = document.createElement('div');
      folder.className = 'kb-folder';

      const header = document.createElement('div');
      header.className = 'kb-folder-header';
      header.innerHTML = `${icon('folder', { size: 16 })}<span>${escapeHtml(department)}</span><span class="count">${docs.length} file${docs.length === 1 ? '' : 's'}</span>`;
      folder.appendChild(header);

      for (const doc of docs) {
        folder.appendChild(renderDocRow(doc));
      }

      kbFolders.appendChild(folder);
    }
  }

  async function deleteDocument(id) {
    if (!confirm('Delete this document from the knowledge base?')) return;
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not delete document');
    await loadDocuments();
  }

  async function uploadFiles(files) {
    hideError();
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    if (currentUser.role === 'admin' && bankwideCheckbox.checked) {
      formData.append('bankwide', 'true');
    }

    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Uploading...';
    try {
      const res = await fetch('/api/documents', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const failed = data.results.filter((r) => r.error);
      if (failed.length) {
        showError(failed.map((f) => `${f.filename}: ${f.error}`).join('; '));
      }
      await loadDocuments();
    } catch (err) {
      showError(err.message || 'Upload failed');
    } finally {
      uploadBtn.disabled = false;
      uploadBtn.innerHTML = `${icon('plus', { size: 14 })} Add files`;
      bankwideCheckbox.checked = false;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  bootstrap();
})();
