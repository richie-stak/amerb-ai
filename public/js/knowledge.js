// The Knowledge base page: three separate knowledge bases, each with its own rules (enforced on
// the server in server/documentAccess.js — this page only reflects them):
//   Bank-wide   every staff member can read; only admins add or remove files
//   Department  shared with one department only; any member can add files
//   My files    a person's own chat attachments and generated documents, private to them
(function () {
  AmerbTheme.wireThemeToggle(document.getElementById('theme-toggle-btn'));

  const kbShell = document.getElementById('kb-shell');
  const kbError = document.getElementById('kb-error');
  const fileInput = document.getElementById('kb-file-input');
  const searchInput = document.getElementById('kb-search');
  const globalList = document.getElementById('kb-global-list');
  const departmentList = document.getElementById('kb-department-list');
  const personalList = document.getElementById('kb-personal-list');
  const departmentTitle = document.getElementById('kb-department-title');
  const departmentHint = document.getElementById('kb-department-hint');
  const deptFilter = document.getElementById('kb-department-filter');
  const noDepartment = document.getElementById('kb-no-department');
  const uploadGlobalBtn = document.getElementById('kb-upload-global-btn');
  const uploadDepartmentBtn = document.getElementById('kb-upload-department-btn');
  const DOC_ICONS = { docx: 'fileText', pdf: 'fileText', xlsx: 'fileSpreadsheet', pptx: 'presentation', text: 'fileText', webpage: 'globe' };

  let currentUser = null;
  let allDocuments = [];
  // Where the next file-picker selection should go: { scope, department? }.
  let pendingUpload = null;

  const isAdmin = () => currentUser.role === 'admin';

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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function bootstrap() {
    const sessionRes = await fetch('/api/session');
    const sessionData = await sessionRes.json();
    if (!sessionData.authenticated) {
      window.location.href = '/login.html';
      return;
    }

    const meRes = await fetch('/api/auth/me');
    currentUser = (await meRes.json()).user;
    kbShell.classList.remove('hidden');

    if (isAdmin()) {
      uploadGlobalBtn.classList.remove('hidden');
      deptFilter.classList.remove('hidden');
      const { departments } = await fetch('/api/auth/departments').then((r) => r.json());
      deptFilter.innerHTML = '<option value="">All departments</option>';
      for (const d of departments) {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = d;
        deptFilter.appendChild(opt);
      }
      if (currentUser.department) deptFilter.value = currentUser.department;
      deptFilter.addEventListener('change', render);
    } else if (!currentUser.department) {
      noDepartment.classList.remove('hidden');
      uploadDepartmentBtn.disabled = true;
    }

    uploadGlobalBtn.addEventListener('click', () => pickFiles({ scope: 'global' }));
    uploadDepartmentBtn.addEventListener('click', () => {
      const department = isAdmin() ? deptFilter.value : currentUser.department;
      if (isAdmin() && !department) {
        showError('Pick a department from the list first, so the files go to the right one.');
        return;
      }
      pickFiles({ scope: 'department', department });
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length && pendingUpload) uploadFiles(Array.from(fileInput.files), pendingUpload);
      fileInput.value = '';
    });
    searchInput.addEventListener('input', render);

    await loadDocuments();
  }

  function pickFiles(target) {
    hideError();
    pendingUpload = target;
    fileInput.click();
  }

  async function loadDocuments() {
    hideError();
    const res = await fetch('/api/documents');
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not load the knowledge base');
    allDocuments = data.documents;
    render();
  }

  function matchesSearch(doc) {
    const q = searchInput.value.trim().toLowerCase();
    return !q || doc.filename.toLowerCase().includes(q) || (doc.uploaded_by || '').toLowerCase().includes(q);
  }

  function render() {
    const docs = allDocuments.filter(matchesSearch);

    renderList(globalList, docs.filter((d) => d.scope === 'global'), 'No bank-wide documents yet.' + (isAdmin() ? ' Add policies here for all staff.' : ''));

    // Department section: staff see their own department; admins pick one (or all) from the list.
    const deptFilterValue = isAdmin() ? deptFilter.value : currentUser.department;
    const departmentDocs = docs.filter((d) => d.scope === 'department' && (!deptFilterValue || d.department === deptFilterValue));
    if (isAdmin()) {
      departmentTitle.textContent = deptFilterValue ? `${deptFilterValue} department` : 'All departments';
      departmentHint.textContent = deptFilterValue
        ? `Shared with everyone in ${deptFilterValue}, and only them. As an admin you can manage every department.`
        : 'Each department sees only its own files. Pick a department to add files to it.';
      uploadDepartmentBtn.innerHTML = `${icon('upload', { size: 14 })} ${deptFilterValue ? `Add to ${escapeHtml(deptFilterValue)}` : 'Add files'}`;
    } else {
      departmentTitle.textContent = currentUser.department ? `${currentUser.department} department` : 'Department';
      departmentHint.textContent = currentUser.department
        ? `Shared with everyone in ${currentUser.department}, and only them. Anyone in the department can add files.`
        : '';
      uploadDepartmentBtn.innerHTML = `${icon('upload', { size: 14 })} Add to ${escapeHtml(currentUser.department || 'department')}`;
    }
    renderList(
      departmentList,
      departmentDocs,
      'No department documents yet.',
      isAdmin() && !deptFilterValue // show which department each file belongs to
    );

    const personalDocs = docs.filter((d) => d.scope === 'personal' && d.user_id === currentUser.id);
    renderList(personalList, personalDocs, 'Nothing yet — files you attach in a chat will appear here.');
  }

  function renderList(container, docs, emptyText, showDepartment = false) {
    container.innerHTML = '';
    if (!docs.length) {
      const empty = document.createElement('div');
      empty.className = 'kb-list-empty';
      empty.textContent = emptyText;
      container.appendChild(empty);
      return;
    }
    for (const doc of docs) container.appendChild(renderDocRow(doc, showDepartment));
  }

  function canDelete(doc) {
    if (isAdmin()) return true;
    if (doc.scope === 'global') return false;
    return doc.user_id === currentUser.id;
  }

  function renderDocRow(doc, showDepartment) {
    const row = document.createElement('div');
    row.className = 'kb-file-row';

    const iconHtml = doc.kind === 'image'
      ? `<img class="chip-thumb kb-row-thumb" src="/api/documents/${doc.id}/image" alt="">`
      : `<span class="file-icon">${icon(DOC_ICONS[doc.kind] || 'fileText', { size: 17 })}</span>`;
    const sizeLabel = doc.kind === 'image'
      ? (doc.char_count ? `${doc.char_count.toLocaleString()} OCR'd chars` : 'image')
      : `${doc.char_count.toLocaleString()} chars`;
    const deptLabel = showDepartment ? `${escapeHtml(doc.department)} · ` : '';

    row.innerHTML = `
      ${iconHtml}
      <span class="file-name">${escapeHtml(doc.filename)}</span>
      <span class="file-meta">${deptLabel}${sizeLabel} · ${escapeHtml(doc.uploaded_by)} · ${formatDate(doc.created_at)}</span>
    `;

    if (doc.scope === 'personal' && currentUser.department) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'table-btn';
      shareBtn.textContent = `Share with ${currentUser.department}`;
      shareBtn.title = `Move this file into the ${currentUser.department} knowledge base so your whole department can use it`;
      shareBtn.addEventListener('click', () => shareDocument(doc));
      row.appendChild(shareBtn);
    }

    const downloadLink = document.createElement('a');
    downloadLink.className = 'table-btn';
    downloadLink.href = `/api/documents/${doc.id}/file?download=1`;
    downloadLink.title = 'Download';
    downloadLink.innerHTML = icon('download', { size: 13 });
    row.appendChild(downloadLink);

    if (canDelete(doc)) {
      const delBtn = document.createElement('button');
      delBtn.className = 'table-btn danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteDocument(doc));
      row.appendChild(delBtn);
    }
    return row;
  }

  async function shareDocument(doc) {
    if (!confirm(`Share "${doc.filename}" with everyone in ${currentUser.department}? It will move to the department knowledge base.`)) return;
    const res = await fetch(`/api/documents/${doc.id}/share`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'department' }),
    });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not share that file');
    await loadDocuments();
  }

  async function deleteDocument(doc) {
    const where = doc.scope === 'global' ? 'the bank-wide knowledge base' : doc.scope === 'department' ? `the ${doc.department} knowledge base` : 'your files';
    if (!confirm(`Delete "${doc.filename}" from ${where}?`)) return;
    const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return showError(data.error || 'Could not delete document');
    await loadDocuments();
  }

  async function uploadFiles(files, target) {
    hideError();
    const formData = new FormData();
    for (const f of files) formData.append('files', f);
    formData.append('scope', target.scope);
    if (target.department) formData.append('department', target.department);

    const btn = target.scope === 'global' ? uploadGlobalBtn : uploadDepartmentBtn;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = 'Uploading...';
    try {
      const res = await fetch('/api/documents', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      const failed = data.results.filter((r) => r.error);
      if (failed.length) showError(failed.map((f) => `${f.filename}: ${f.error}`).join('; '));
      await loadDocuments();
    } catch (err) {
      showError(err.message || 'Upload failed');
    } finally {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }

  bootstrap();
})();
