'use strict';
// ══════════════════════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════════════════════
const API_BASE = window.location.origin + '/api';
const WS_URL  = (window.location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + window.location.host + '/ws';

// ══════════════════════════════════════════════════════════════
//  STATE
// ══════════════════════════════════════════════════════════════
let currentUser   = null;
let token         = localStorage.getItem('cb_token') || null;
let projects      = [];
let currentProject = null;
let tasks         = [];
let members       = [];         // current project members (incl owner)
let onlineUsers   = new Map();  // userId -> {name, avatar}
let ws            = null;
let wsReconnectTimer = null;

let activeFilter    = 'all';
let dragId          = null;
let dragSourceCol   = null;
let editingTaskId   = null;
let detailTaskId    = null;
let ctxTaskId       = null;
let selectedTags    = [];
let selectedPriority = 'medium';
let selectedCol     = 'todo';
let selectedProjectColor = '#c8ff57';
let selectedProjectIcon  = '📋';
let psSwatch        = '#c8ff57';
let regAvatarFile   = null;
let profileAvatarFile = null;
let activeTaskTab   = 'details';
let notifDropdownOpen = false;
let userDropdownOpen  = false;

const TAG_LIST = ['frontend','backend','design','bug','feature','urgent','api'];
const TAGS_MAP = {
  frontend:'tag-frontend', backend:'tag-backend', design:'tag-design',
  bug:'tag-bug', feature:'tag-feature', urgent:'tag-urgent', api:'tag-api'
};
const STATUS_LABELS = {todo:'To Do', inprog:'In Progress', review:'Review', done:'Done'};
const PRIORITY_ICONS = {low:'🟢',medium:'🟡',high:'🔴'};

// ══════════════════════════════════════════════════════════════
//  API CLIENT
// ══════════════════════════════════════════════════════════════
async function api(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  try {
    const res = await fetch(API_BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      ...opts
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && data.code === 'TOKEN_EXPIRED') {
        doLogout();
        return null;
      }
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  } catch (err) {
    if (!opts.silent) toast(err.message, 'error');
    throw err;
  }
}

async function uploadAvatar(file) {
  const form = new FormData();
  form.append('avatar', file);
  const res = await fetch(API_BASE + '/upload/avatar', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: form
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return data.avatarUrl;
}

// ══════════════════════════════════════════════════════════════
//  WEBSOCKET REAL-TIME
// ══════════════════════════════════════════════════════════════
function connectWs() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(wsReconnectTimer);

  setWsStatus('connecting');
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    setWsStatus('connected');
    ws.send(JSON.stringify({ type: 'auth', payload: { token } }));
  };

  ws.onmessage = (e) => {
    try { handleWsEvent(JSON.parse(e.data)); } catch {}
  };

  ws.onclose = () => {
    setWsStatus('error');
    wsReconnectTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

function wsSend(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, payload }));
  }
}

function handleWsEvent({ event, data }) {
  switch (event) {
    case 'auth:ok': {
      if (currentProject) wsSend('join', { projectId: currentProject.id });
      break;
    }
    case 'room:online': {
      onlineUsers.clear();
      data.forEach(u => onlineUsers.set(u.userId, u));
      renderOnlinePresence();
      break;
    }
    case 'user:join': {
      if (data.userId !== currentUser?.id) {
        onlineUsers.set(data.userId, data);
        renderOnlinePresence();
        toast(`${data.name} joined the project`, 'info');
      }
      break;
    }
    case 'user:leave': {
      onlineUsers.delete(data.userId);
      renderOnlinePresence();
      break;
    }
    case 'task:created': {
      if (!tasks.find(t => t.id === data.id)) {
        tasks.push(data);
        renderBoard();
        toast(`${data.reporter?.name || 'Someone'} added "${data.title}"`, 'info');
      }
      break;
    }
    case 'task:updated': {
      const idx = tasks.findIndex(t => t.id === data.id);
      if (idx >= 0) { tasks[idx] = data; renderBoard(); }
      // Update detail modal if open
      if (detailTaskId === data.id) populateTaskDetail(data);
      break;
    }
    case 'task:deleted': {
      tasks = tasks.filter(t => t.id !== data.id);
      if (detailTaskId === data.id) closeTaskDetail();
      renderBoard();
      break;
    }
    case 'tasks:reordered': {
      data.order.forEach(({id, position, status}) => {
        const t = tasks.find(x => x.id === id);
        if (t) { t.position = position; t.status = status; }
      });
      renderBoard();
      break;
    }
    case 'comment:added': {
      if (detailTaskId === data.taskId) appendComment(data.comment);
      const t = tasks.find(x => x.id === data.taskId);
      if (t) { t.commentCount = (t.commentCount||0)+1; renderBoard(); }
      break;
    }
    case 'comment:deleted': {
      if (detailTaskId === data.taskId) {
        document.getElementById(`comment-${data.commentId}`)?.remove();
      }
      break;
    }
    case 'project:updated': {
      if (currentProject && currentProject.id === data.id) {
        currentProject = { ...currentProject, ...data };
        document.getElementById('breadcrumb-name').textContent = data.name;
      }
      break;
    }
    case 'member:joined': {
      if (!members.find(m => m.id === data.id)) {
        members.push(data);
        toast(`${data.name} joined the project`, 'info');
      }
      break;
    }
    case 'member:removed': {
      members = members.filter(m => m.id !== data.userId);
      if (data.userId === currentUser?.id) {
        toast('You were removed from this project', 'error');
        goHome();
      }
      break;
    }
  }
}

function setWsStatus(status) {
  const dot = document.getElementById('ws-dot');
  if (!dot) return;
  dot.className = 'ws-dot ' + status;
  document.getElementById('ws-status').title = { connected: 'Connected', connecting: 'Connecting…', error: 'Disconnected' }[status];
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════
(async function init() {
  // Check for invite token in URL
  const urlPath = window.location.pathname;
  const inviteMatch = urlPath.match(/\/invite\/([a-f0-9-]+)/i);

  if (token) {
    try {
      const data = await api('GET', '/auth/me', null, { silent: true });
      if (data?.user) {
        currentUser = data.user;
        hideLoading();
        if (inviteMatch && inviteMatch[1]) await acceptInvite(inviteMatch[1]);
        launchApp();
        connectWs();
        return;
      }
    } catch {}
    token = null;
    localStorage.removeItem('cb_token');
  }

  hideLoading();
  if (inviteMatch) localStorage.setItem('cb_invite', inviteMatch[1]);
  showAuthScreen();
})();

function hideLoading() {
  const el = document.getElementById('loading-screen');
  el.style.opacity = '0';
  setTimeout(() => el.style.display = 'none', 400);
}

function showAuthScreen() {
  document.getElementById('auth-screen').classList.add('show');
}

// ══════════════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════════════
function showRegister() {
  document.getElementById('auth-login-card').classList.add('hidden');
  document.getElementById('auth-register-card').classList.remove('hidden');
}
function showLogin() {
  document.getElementById('auth-register-card').classList.add('hidden');
  document.getElementById('auth-login-card').classList.remove('hidden');
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  errEl.classList.remove('show');

  if (!email || !password) { errEl.textContent = 'Email and password required.'; errEl.classList.add('show'); return; }

  btn.classList.add('loading');
  btn.textContent = 'Signing in…';
  try {
    const data = await api('POST', '/auth/login', { email, password });
    if (!data) return;
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('cb_token', token);
    document.getElementById('auth-screen').classList.remove('show');
    const pendingInvite = localStorage.getItem('cb_invite');
    if (pendingInvite) { localStorage.removeItem('cb_invite'); await acceptInvite(pendingInvite); }
    launchApp();
    connectWs();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    btn.classList.remove('loading');
    btn.textContent = 'Sign in →';
  }
}

async function doRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const errEl = document.getElementById('reg-error');
  const btn = document.getElementById('register-btn');
  errEl.classList.remove('show');

  if (!name || !email || !password) { errEl.textContent = 'All fields required.'; errEl.classList.add('show'); return; }
  if (password.length < 6) { errEl.textContent = 'Password must be at least 6 characters.'; errEl.classList.add('show'); return; }

  btn.classList.add('loading');
  btn.textContent = 'Creating account…';
  try {
    const data = await api('POST', '/auth/register', { name, email, password });
    if (!data) return;
    token = data.token;
    currentUser = data.user;
    localStorage.setItem('cb_token', token);

    // Upload avatar if selected
    if (regAvatarFile) {
      try {
        const url = await uploadAvatar(regAvatarFile);
        currentUser.avatar = url;
      } catch {}
    }

    document.getElementById('auth-screen').classList.remove('show');
    const pendingInvite = localStorage.getItem('cb_invite');
    if (pendingInvite) { localStorage.removeItem('cb_invite'); await acceptInvite(pendingInvite); }
    launchApp();
    connectWs();
    // Seed demo project for new users
    await seedDemoProject();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.classList.add('show');
  } finally {
    btn.classList.remove('loading');
    btn.textContent = 'Create Account →';
  }
}

async function doLogout() {
  closeUserDropdown();
  try { await api('POST', '/auth/logout', null, { silent: true }); } catch {}
  token = null;
  currentUser = null;
  currentProject = null;
  tasks = [];
  localStorage.removeItem('cb_token');
  if (ws) ws.close();
  document.getElementById('app-screen').classList.remove('show');
  document.getElementById('auth-screen').classList.add('show');
  showLogin();
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

async function acceptInvite(inviteToken) {
  try {
    await api('POST', '/auth/invite/accept', { token: inviteToken });
    toast('Successfully joined the project!', 'success');
  } catch {}
  history.replaceState({}, '', '/');
}

async function seedDemoProject() {
  try {
    const pData = await api('POST', '/projects', {
      name: 'My First Project',
      description: 'A sample project to get you started 🚀',
      icon: '🚀',
      color: '#c8ff57'
    });
    if (!pData?.project) return;
    const pid = pData.project.id;
    await api('POST', '/tasks/' + pid, { title: 'Welcome to CollabBoard!', description: 'Drag cards between columns, assign teammates, and set due dates.', status: 'done', priority: 'low', tags: ['feature'] });
    await api('POST', '/tasks/' + pid, { title: 'Create your first task', status: 'todo', priority: 'medium', tags: [] });
    await api('POST', '/tasks/' + pid, { title: 'Invite a teammate', description: 'Go to Team → Invite to add colleagues.', status: 'inprog', priority: 'high', tags: ['feature'] });
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  APP LAUNCH
// ══════════════════════════════════════════════════════════════
function launchApp() {
  document.getElementById('app-screen').classList.add('show');
  refreshTopbarUser();
  loadNotifications();
  showHub();
}

function refreshTopbarUser() {
  if (!currentUser) return;
  const av = document.getElementById('topbar-avatar');
  const initials = getInitials(currentUser.name);
  if (currentUser.avatar) {
    av.innerHTML = `<img src="${currentUser.avatar}" alt="av"/>`;
  } else {
    av.textContent = initials;
    av.style.background = 'var(--accent)';
    av.style.color = 'var(--accent-text)';
  }
  document.getElementById('topbar-username').textContent = currentUser.name.split(' ')[0];
  document.getElementById('dd-name').textContent = currentUser.name;
  document.getElementById('dd-email').textContent = currentUser.email;

  // comment input avatar
  const cav = document.getElementById('comment-input-av');
  if (cav) {
    if (currentUser.avatar) cav.innerHTML = `<img src="${currentUser.avatar}" alt="av"/>`;
    else cav.textContent = initials;
  }
}

// ══════════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════════
async function showHub() {
  document.getElementById('projects-hub').classList.add('show');
  document.getElementById('board-screen').classList.remove('show');
  document.getElementById('topbar-breadcrumb').classList.add('hidden');
  document.getElementById('online-presence').style.display = 'none';
  if (currentProject) wsSend('leave', {});
  currentProject = null;
  tasks = [];
  onlineUsers.clear();
  await loadProjects();
}

async function openProject(id) {
  currentProject = projects.find(p => p.id === id);
  if (!currentProject) return;
  document.getElementById('projects-hub').classList.remove('show');
  document.getElementById('board-screen').classList.add('show');
  document.getElementById('topbar-breadcrumb').classList.remove('hidden');
  document.getElementById('breadcrumb-name').textContent = currentProject.name;
  document.getElementById('online-presence').style.display = 'flex';
  activeFilter = 'all';
  document.getElementById('search-input').value = '';
  document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));
  renderBoard(); // Show skeleton
  await Promise.all([loadTasks(), loadMembers()]);
  // Join WS room
  wsSend('join', { projectId: currentProject.id });
}

function goHome() { closeUserDropdown(); showHub(); }

// ══════════════════════════════════════════════════════════════
//  PROJECTS
// ══════════════════════════════════════════════════════════════
async function loadProjects() {
  try {
    const data = await api('GET', '/projects');
    if (!data) return;
    projects = data.projects || [];
    renderHub();
  } catch {}
}

function renderHub() {
  const grid = document.getElementById('projects-grid');
  grid.innerHTML = '';

  const myProjects = projects.filter(p => p.isOwner);
  const sharedProjects = projects.filter(p => !p.isOwner);

  if (projects.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text3)">
      <div style="font-size:40px;margin-bottom:12px">📋</div>
      <div style="font-size:16px;font-weight:600;color:var(--text2);margin-bottom:6px">No projects yet</div>
      <div style="font-size:13px">Create your first project to get started</div>
    </div>`;
  }

  const renderSection = (list, label) => {
    if (list.length === 0) return;
    if (label) {
      const sec = document.createElement('div');
      sec.className = 'hub-section-label';
      sec.style.gridColumn = '1/-1';
      sec.textContent = label;
      grid.appendChild(sec);
    }
    list.forEach(p => {
      const done = p.taskCounts?.done || 0;
      const total = p.totalTasks || 0;
      const pct = total ? Math.round(done / total * 100) : 0;
      const card = document.createElement('div');
      card.className = 'project-card';
      card.style.setProperty('--project-color', p.color || 'var(--accent)');
      const membersHtml = (p.members || []).slice(0, 5).map(m =>
        `<div class="project-member-av" title="${esc(m.name)}" style="background:${strToColor(m.name)}">
          ${m.avatar ? `<img src="${m.avatar}" alt=""/>` : getInitials(m.name)}
        </div>`
      ).join('');
      card.innerHTML = `
        <div class="project-card-top">
          <div class="project-icon" style="background:${p.color}22">${p.icon || '📋'}</div>
          <button class="btn btn-ghost btn-sm project-card-menu" onclick="event.stopPropagation();openProjectCtx(event,'${p.id}')">⋯</button>
        </div>
        <div class="project-name">${esc(p.name)} ${!p.isOwner ? '<span class="project-role-badge guest">guest</span>' : ''}</div>
        <div class="project-desc">${esc(p.description || '')}</div>
        <div class="project-stats">
          <div class="project-stat"><strong>${total}</strong> tasks</div>
          <div class="project-stat"><strong>${done}</strong> done</div>
          <div class="project-stat"><strong>${pct}%</strong> complete</div>
        </div>
        <div class="progress-bar-wrap"><div class="progress-bar" style="width:${pct}%;background:${p.color||'var(--accent)'}"></div></div>
        <div class="project-members">${membersHtml}</div>
        <div class="project-date">Created ${timeAgo(p.created_at)}</div>`;
      card.addEventListener('click', () => openProject(p.id));
      grid.appendChild(card);
    });
  };

  renderSection(myProjects, myProjects.length && sharedProjects.length ? 'My Projects' : '');
  renderSection(sharedProjects, 'Shared with me');

  // New project card
  const newCard = document.createElement('div');
  newCard.className = 'project-card project-card-new';
  newCard.innerHTML = `<div class="new-project-plus">+</div><div>New Project</div>`;
  newCard.onclick = openNewProjectModal;
  grid.appendChild(newCard);

  document.getElementById('hub-subtitle').textContent =
    `${projects.length} project${projects.length !== 1 ? 's' : ''} total`;
}

let projCtxId = null;
function openProjectCtx(e, id) {
  e.preventDefault();
  projCtxId = id;
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = `
    <div class="ctx-item" onclick="openProjSettingsFromCtx('${id}')">⚙️ Settings</div>
    <div class="ctx-item" onclick="openProjMembersFromCtx('${id}')">👥 Members</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" onclick="confirmDeleteProject('${id}')">🗑 Delete</div>`;
  positionMenu(menu, e.clientX, e.clientY);
  menu.classList.add('open');
}
async function openProjSettingsFromCtx(id) {
  closeCtxMenu();
  await openProject(id);
  openProjectSettingsModal();
}
async function openProjMembersFromCtx(id) {
  closeCtxMenu();
  await openProject(id);
  openMembersModal();
}
async function confirmDeleteProject(id) {
  closeCtxMenu();
  if (!confirm('Delete this project and all its tasks? This cannot be undone.')) return;
  try {
    await api('DELETE', '/projects/' + id);
    projects = projects.filter(p => p.id !== id);
    if (currentProject?.id === id) goHome();
    else renderHub();
    toast('Project deleted', 'success');
  } catch {}
}

// Project modals
function openNewProjectModal() {
  closeUserDropdown();
  selectedProjectColor = '#c8ff57';
  selectedProjectIcon = '📋';
  document.getElementById('np-name').value = '';
  document.getElementById('np-desc').value = '';
  document.getElementById('np-icon-preview').textContent = '📋';
  document.querySelectorAll('#swatch-row .swatch').forEach((s,i) => s.classList.toggle('selected', i === 0));
  document.querySelectorAll('#icon-picker .icon-opt').forEach((el,i) => el.style.borderColor = i === 0 ? 'var(--accent)' : 'transparent');
  document.getElementById('new-project-modal').classList.add('open');
  setTimeout(() => document.getElementById('np-name').focus(), 80);
}
function closeNewProjectModal() { document.getElementById('new-project-modal').classList.remove('open'); }

function selectIcon(icon, el) {
  selectedProjectIcon = icon;
  document.getElementById('np-icon-preview').textContent = icon;
  document.querySelectorAll('#icon-picker .icon-opt').forEach(e => e.style.borderColor = 'transparent');
  el.style.borderColor = 'var(--accent)';
}
function selectSwatch(el, prefix) {
  const color = el.dataset.color;
  if (prefix === 'np') selectedProjectColor = color;
  else if (prefix === 'ps') psSwatch = color;
  document.querySelectorAll(`#${prefix === 'np' ? 'swatch-row' : 'ps-swatch-row'} .swatch`).forEach(s => s.classList.toggle('selected', s === el));
}

async function createProject() {
  const name = document.getElementById('np-name').value.trim();
  if (!name) { toast('Project name required', 'error'); return; }
  try {
    const data = await api('POST', '/projects', {
      name,
      description: document.getElementById('np-desc').value.trim(),
      icon: selectedProjectIcon,
      color: selectedProjectColor
    });
    if (!data) return;
    closeNewProjectModal();
    toast('Project created!', 'success');
    projects.unshift(data.project);
    await openProject(data.project.id);
  } catch {}
}

function openProjectSettingsModal() {
  if (!currentProject) return;
  document.getElementById('ps-name').value = currentProject.name;
  document.getElementById('ps-desc').value = currentProject.description || '';
  psSwatch = currentProject.color || '#c8ff57';
  document.querySelectorAll('#ps-swatch-row .swatch').forEach(s => s.classList.toggle('selected', s.dataset.color === psSwatch));
  const isOwner = currentProject.owner_id === currentUser?.id;
  document.getElementById('ps-delete-btn').style.display = isOwner ? 'flex' : 'none';
  document.getElementById('proj-settings-modal').classList.add('open');
}
function closeProjSettingsModal() { document.getElementById('proj-settings-modal').classList.remove('open'); }

async function saveProjSettings() {
  const name = document.getElementById('ps-name').value.trim();
  if (!name) return;
  try {
    const data = await api('PATCH', '/projects/' + currentProject.id, {
      name, description: document.getElementById('ps-desc').value.trim(), color: psSwatch
    });
    if (!data) return;
    currentProject = { ...currentProject, ...data.project };
    document.getElementById('breadcrumb-name').textContent = currentProject.name;
    closeProjSettingsModal();
    toast('Project updated', 'success');
    renderHub();
  } catch {}
}

async function deleteCurrentProject() {
  closeProjSettingsModal();
  if (!confirm('Delete this project and all tasks? Cannot be undone.')) return;
  try {
    await api('DELETE', '/projects/' + currentProject.id);
    toast('Project deleted', 'success');
    goHome();
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  TASKS
// ══════════════════════════════════════════════════════════════
async function loadTasks() {
  try {
    const data = await api('GET', '/tasks/' + currentProject.id);
    if (!data) return;
    tasks = data.tasks || [];
    renderBoard();
  } catch {}
}

async function loadMembers() {
  try {
    const data = await api('GET', '/members/' + currentProject.id);
    if (!data) return;
    members = [data.owner, ...(data.members || [])];
    populateAssigneeDropdowns();
  } catch {}
}

function populateAssigneeDropdowns() {
  const selects = ['task-assignee', 'td-assignee'];
  selects.forEach(id => {
    const sel = document.getElementById(id);
    if (!sel) return;
    const current = sel.value;
    sel.innerHTML = '<option value="">Unassigned</option>' +
      members.map(m => `<option value="${m.id}" ${m.id === current ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  });
}

// ── BOARD RENDER ──
function renderBoard() {
  const cols = ['todo','inprog','review','done'];
  const searchQ = (document.getElementById('search-input')?.value || '').toLowerCase();

  cols.forEach(col => {
    const el = document.getElementById('col-' + col);
    const colTasks = tasks.filter(t => t.status === col);
    const filtered = colTasks.filter(t => matchFilter(t) && matchSearch(t, searchQ));

    el.innerHTML = '';
    el.ondragover = e => onDragOver(e, col);
    el.ondragleave = onDragLeave;
    el.ondrop = e => onDrop(e, col);

    if (filtered.length === 0) {
      el.innerHTML = `<div class="empty-col">No tasks here<br/>Drop or click + to add</div>`;
    } else {
      filtered.forEach(t => el.appendChild(makeCard(t)));
    }
    document.getElementById('count-' + col).textContent = colTasks.length;
  });

  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  document.getElementById('total-count').textContent = total;
  document.getElementById('done-count').textContent = done;
}

function matchFilter(t) {
  if (activeFilter === 'high') return t.priority === 'high';
  if (activeFilter === 'mine') return t.assignee?.id === currentUser?.id || t.assignee_id === currentUser?.id;
  if (activeFilter === 'overdue') {
    if (!t.due_date || t.status === 'done') return false;
    return new Date(t.due_date) < new Date(new Date().toDateString());
  }
  return true;
}
function matchSearch(t, q) {
  if (!q) return true;
  return t.title.toLowerCase().includes(q) || (t.description||'').toLowerCase().includes(q) || (t.tags||[]).some(tg => tg.includes(q));
}
function setFilter(f, btn) {
  activeFilter = f;
  document.querySelectorAll('.filter-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderBoard();
}

function makeCard(t) {
  const div = document.createElement('div');
  div.className = 'card';
  div.draggable = true;
  div.dataset.id = t.id;

  div.addEventListener('dragstart', e => {
    dragId = t.id;
    dragSourceCol = t.status;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => div.classList.add('dragging'), 0);
  });
  div.addEventListener('dragend', () => { div.classList.remove('dragging'); dragId = null; });
  div.addEventListener('contextmenu', e => { e.preventDefault(); openCtxMenu(e, t.id); });
  div.addEventListener('click', e => {
    if (e.target.classList.contains('card-delete')) return;
    openTaskDetail(t.id);
  });

  // Due date
  let dueHtml = '';
  if (t.due_date) {
    const now = new Date(); now.setHours(0,0,0,0);
    const d = new Date(t.due_date + 'T00:00:00');
    const diff = Math.ceil((d - now) / 86400000);
    let cls = 'due-chip';
    let label;
    if (diff < 0) { cls += ' overdue'; label = `${-diff}d overdue`; }
    else if (diff === 0) { cls += ' today'; label = 'Today'; }
    else if (diff <= 2) { cls += ' soon'; label = diff === 1 ? 'Tomorrow' : `${diff}d`; }
    else label = `${diff}d`;
    dueHtml = `<span class="${cls}">${label}</span>`;
  }

  // Assignee
  const assignee = t.assignee || (t.assignee_id ? members.find(m => m.id === t.assignee_id) : null);
  const avHtml = assignee
    ? (assignee.avatar
        ? `<img src="${assignee.avatar}" alt="${esc(assignee.name)}"/>`
        : `<span>${getInitials(assignee.name)}</span>`)
    : '';
  const avStyle = assignee ? `background:${strToColor(assignee.name)};color:#fff` : 'display:none';

  // Checklist badge
  const cl = t.checklist || [];
  const clDone = cl.filter(i => i.done).length;
  const clBadge = cl.length ? `<span class="card-checklist-badge" title="Checklist">☑ ${clDone}/${cl.length}</span>` : '';
  const cmBadge = t.commentCount ? `<span class="card-comment-badge" title="Comments">💬 ${t.commentCount}</span>` : '';

  div.innerHTML = `
    ${t.cover_color ? `<div class="card-cover" style="background:${t.cover_color}"></div>` : ''}
    <div class="card-title">${esc(t.title)}</div>
    ${t.tags?.length ? `<div class="card-tags">${t.tags.map(tg => `<span class="tag ${TAGS_MAP[tg]||''}">${esc(tg)}</span>`).join('')}</div>` : ''}
    <div class="card-footer">
      <div class="card-priority p-${t.priority}">
        <div class="priority-pip"></div>${t.priority}
        ${dueHtml}
      </div>
      <div class="card-right">
        <div class="card-meta">${clBadge}${cmBadge}</div>
        <div class="card-assignee-av" style="${avStyle}" title="${esc(assignee?.name||'')}">${avHtml}</div>
        <button class="card-delete" onclick="event.stopPropagation();deleteTask('${t.id}')" title="Delete">×</button>
      </div>
    </div>`;
  return div;
}

// Task CRUD
function openTaskModal(col) {
  editingTaskId = null;
  selectedTags = [];
  selectedPriority = 'medium';
  selectedCol = col || 'todo';
  buildTagPicker('tag-picker', []);
  document.getElementById('task-title').value = '';
  document.getElementById('task-desc').value = '';
  document.getElementById('task-due').value = '';
  document.getElementById('task-hours').value = '';
  document.getElementById('task-modal-title').textContent = 'New Task';
  document.querySelectorAll('#priority-picker .picker-opt').forEach((el,i) => el.classList.toggle('selected', i === 1));
  document.querySelectorAll('#col-picker .picker-opt').forEach((el,i) => el.classList.toggle('selected', ['todo','inprog','review','done'][i] === selectedCol));
  populateAssigneeDropdowns();
  document.getElementById('task-modal').classList.add('open');
  setTimeout(() => document.getElementById('task-title').focus(), 80);
}
function closeTaskModal() { document.getElementById('task-modal').classList.remove('open'); }

async function saveTask() {
  const title = document.getElementById('task-title').value.trim();
  if (!title) { document.getElementById('task-title').focus(); return; }
  const btn = document.getElementById('task-save-btn');
  btn.disabled = true;

  const body = {
    title,
    description: document.getElementById('task-desc').value.trim(),
    tags: [...selectedTags],
    priority: selectedPriority,
    status: selectedCol,
    assignee_id: document.getElementById('task-assignee').value || null,
    due_date: document.getElementById('task-due').value || null,
    estimated_hours: parseFloat(document.getElementById('task-hours').value) || null
  };

  try {
    if (editingTaskId) {
      const data = await api('PATCH', `/tasks/${currentProject.id}/${editingTaskId}`, body);
      if (!data) return;
      const idx = tasks.findIndex(t => t.id === editingTaskId);
      if (idx >= 0) tasks[idx] = data.task;
      toast('Task updated', 'success');
    } else {
      const data = await api('POST', '/tasks/' + currentProject.id, body);
      if (!data) return;
      tasks.push(data.task);
      toast('Task added!', 'success');
    }
    closeTaskModal();
    renderBoard();
  } catch {} finally {
    btn.disabled = false;
  }
}

async function deleteTask(id) {
  try {
    await api('DELETE', `/tasks/${currentProject.id}/${id}`);
    tasks = tasks.filter(t => t.id !== id);
    renderBoard();
    toast('Task deleted');
  } catch {}
}

// Tag picker
function buildTagPicker(containerId, selected) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = TAG_LIST.map(tg =>
    `<span class="tag-opt ${TAGS_MAP[tg]||''} ${selected.includes(tg)?'selected':''}"
      onclick="toggleTag(this,'${tg}','${containerId}')">${tg}</span>`
  ).join('');
}
function toggleTag(el, tag, containerId) {
  el.classList.toggle('selected');
  if (containerId === 'td-tag-picker') {
    // update live
    const t = tasks.find(x => x.id === detailTaskId);
    if (t) {
      if (!t.tags.includes(tag)) t.tags.push(tag);
      else t.tags = t.tags.filter(x => x !== tag);
      updateTaskField('tags', t.tags);
    }
  } else {
    if (selectedTags.includes(tag)) selectedTags = selectedTags.filter(x => x !== tag);
    else selectedTags.push(tag);
  }
}
function setPriority(p, el) {
  selectedPriority = p;
  document.querySelectorAll('#priority-picker .picker-opt').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}
function setColPick(c, el) {
  selectedCol = c;
  document.querySelectorAll('#col-picker .picker-opt').forEach(b => b.classList.remove('selected'));
  el.classList.add('selected');
}

// ── TASK DETAIL MODAL ──
function openTaskDetail(id) {
  const t = tasks.find(x => x.id === id);
  if (!t) return;
  detailTaskId = id;
  activeTaskTab = 'details';
  switchTaskTab('details', null);
  populateTaskDetail(t);
  document.getElementById('task-detail-modal').classList.add('open');
  // Load comments
  loadComments(id);
}
function closeTaskDetail() {
  document.getElementById('task-detail-modal').classList.remove('open');
  detailTaskId = null;
}

function populateTaskDetail(t) {
  document.getElementById('td-title').value = t.title;
  document.getElementById('td-desc').value = t.description || '';
  document.getElementById('td-due').value = t.due_date || '';
  document.getElementById('td-hours').value = t.estimated_hours || '';
  document.getElementById('td-project-name').textContent = currentProject?.name || '';
  document.getElementById('td-status-badge').textContent = STATUS_LABELS[t.status] || t.status;
  document.getElementById('td-priority').textContent = (PRIORITY_ICONS[t.priority]||'') + ' ' + (t.priority||'');
  document.getElementById('td-comment-count').textContent = t.commentCount ? `(${t.commentCount})` : '';

  // Tags
  const tags = t.tags || [];
  buildTagPicker('td-tag-picker', tags);

  // Assignee
  populateAssigneeDropdowns();
  const asgSel = document.getElementById('td-assignee');
  if (asgSel) asgSel.value = t.assignee_id || t.assignee?.id || '';

  // Checklist
  renderChecklist(t.checklist || []);
}

function switchTaskTab(tab, btn) {
  activeTaskTab = tab;
  ['details','checklist','comments'].forEach(t => {
    document.getElementById('task-tab-' + t).style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('.modal-tab').forEach((el, i) => {
    el.classList.toggle('active', ['details','checklist','comments'][i] === tab);
  });
}

async function updateTaskField(field, value) {
  if (!detailTaskId || !currentProject) return;
  try {
    const body = { [field]: value };
    const data = await api('PATCH', `/tasks/${currentProject.id}/${detailTaskId}`, body, { silent: true });
    if (!data) return;
    const idx = tasks.findIndex(t => t.id === detailTaskId);
    if (idx >= 0) tasks[idx] = data.task;
    renderBoard();
  } catch {}
}

function deleteTaskFromDetail() {
  const id = detailTaskId;
  closeTaskDetail();
  deleteTask(id);
}

// ── CHECKLIST ──
function renderChecklist(items) {
  const done = items.filter(i => i.done).length;
  const total = items.length;
  const pct = total ? Math.round(done / total * 100) : 0;
  document.getElementById('cl-progress-fill').style.width = pct + '%';
  document.getElementById('cl-progress-text').textContent = `${done} / ${total}`;
  document.getElementById('td-checklist-count').textContent = total ? `(${done}/${total})` : '';

  const wrap = document.getElementById('checklist-items');
  wrap.innerHTML = '';
  items.forEach((item, idx) => {
    const div = document.createElement('div');
    div.className = 'checklist-item' + (item.done ? ' done-item' : '');
    div.innerHTML = `
      <input type="checkbox" ${item.done ? 'checked' : ''} onchange="toggleChecklistItem(${idx},this.checked)"/>
      <input class="checklist-item-text" value="${esc(item.text)}" onblur="updateChecklistText(${idx},this.value)"/>
      <button class="checklist-item-del" onclick="removeChecklistItem(${idx})">×</button>`;
    wrap.appendChild(div);
  });
}

function getTaskChecklist() {
  const t = tasks.find(x => x.id === detailTaskId);
  return t ? [...(t.checklist || [])] : [];
}
async function toggleChecklistItem(idx, done) {
  const cl = getTaskChecklist();
  cl[idx].done = done;
  const t = tasks.find(x => x.id === detailTaskId);
  if (t) t.checklist = cl;
  renderChecklist(cl);
  await updateTaskField('checklist', cl);
}
async function updateChecklistText(idx, text) {
  const cl = getTaskChecklist();
  cl[idx].text = text;
  await updateTaskField('checklist', cl);
}
async function removeChecklistItem(idx) {
  const cl = getTaskChecklist();
  cl.splice(idx, 1);
  const t = tasks.find(x => x.id === detailTaskId);
  if (t) t.checklist = cl;
  renderChecklist(cl);
  await updateTaskField('checklist', cl);
}
async function addChecklistItem() {
  const input = document.getElementById('checklist-new-input');
  const text = input.value.trim();
  if (!text) return;
  const cl = getTaskChecklist();
  cl.push({ text, done: false });
  const t = tasks.find(x => x.id === detailTaskId);
  if (t) t.checklist = cl;
  renderChecklist(cl);
  input.value = '';
  await updateTaskField('checklist', cl);
}

// ── COMMENTS ──
async function loadComments(taskId) {
  try {
    const data = await api('GET', `/tasks/${currentProject.id}/${taskId}/comments`);
    if (!data) return;
    const list = document.getElementById('comments-list');
    list.innerHTML = '';
    if (!data.comments.length) {
      list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text3);font-size:12px">No comments yet</div>';
      return;
    }
    data.comments.forEach(c => appendComment(c));
  } catch {}
}

function appendComment(c) {
  const list = document.getElementById('comments-list');
  const emptyMsg = list.querySelector('div[style]');
  if (emptyMsg) emptyMsg.remove();

  const div = document.createElement('div');
  div.className = 'comment-item';
  div.id = `comment-${c.id}`;
  const initials = getInitials(c.user_name || '?');
  const reactions = c.reactions || {};
  const reactHtml = Object.entries(reactions).filter(([,users]) => users.length).map(([emoji, users]) =>
    `<button class="reaction-btn ${users.includes(currentUser?.id) ? 'mine' : ''}" onclick="reactToComment('${c.id}','${emoji}')">${emoji} ${users.length}</button>`
  ).join('');
  const canDelete = c.user_id === currentUser?.id;

  div.innerHTML = `
    <div class="comment-av" style="${c.user_avatar ? '' : 'background:' + strToColor(c.user_name||'?')}">
      ${c.user_avatar ? `<img src="${c.user_avatar}" alt=""/>` : initials}
    </div>
    <div class="comment-body">
      <div class="comment-header">
        <span class="comment-name">${esc(c.user_name)}</span>
        <span class="comment-time">${timeAgo(c.created_at)}</span>
        ${c.edited ? '<span class="comment-edited">(edited)</span>' : ''}
      </div>
      <div class="comment-text">${esc(c.body)}</div>
      <div class="comment-reactions">${reactHtml}
        <button class="reaction-btn" onclick="reactToComment('${c.id}','👍')" title="Like">👍</button>
        <button class="reaction-btn" onclick="reactToComment('${c.id}','✅')" title="Done">✅</button>
        <button class="reaction-btn" onclick="reactToComment('${c.id}','🔥')" title="Fire">🔥</button>
      </div>
      <div class="comment-actions">
        ${canDelete ? `<button class="comment-action-btn danger" onclick="deleteComment('${c.id}','${c.task_id||detailTaskId}')">Delete</button>` : ''}
      </div>
    </div>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

async function submitComment() {
  const input = document.getElementById('comment-input');
  const body = input.value.trim();
  if (!body || !detailTaskId) return;
  input.value = '';
  input.style.height = 'auto';
  try {
    const data = await api('POST', `/tasks/${currentProject.id}/${detailTaskId}/comments`, { body });
    if (!data) return;
    appendComment(data.comment);
    const t = tasks.find(x => x.id === detailTaskId);
    if (t) { t.commentCount = (t.commentCount||0)+1; }
    document.getElementById('td-comment-count').textContent = `(${t?.commentCount||1})`;
    renderBoard();
  } catch {}
}

async function reactToComment(commentId, reaction) {
  try {
    await api('PATCH', `/tasks/${currentProject.id}/${detailTaskId}/comments/${commentId}`, { reaction });
    await loadComments(detailTaskId);
  } catch {}
}

async function deleteComment(commentId, taskId) {
  try {
    await api('DELETE', `/tasks/${currentProject.id}/${taskId}/comments/${commentId}`);
    document.getElementById(`comment-${commentId}`)?.remove();
    const t = tasks.find(x => x.id === taskId);
    if (t) t.commentCount = Math.max(0, (t.commentCount||1)-1);
    renderBoard();
  } catch {}
}

// ── DRAG & DROP ──
function onDragOver(e, col) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.style.outline = '2px dashed var(--accent)';
  e.currentTarget.style.outlineOffset = '-2px';
}
function onDragLeave(e) {
  e.currentTarget.style.outline = '';
}
async function onDrop(e, col) {
  e.preventDefault();
  e.currentTarget.style.outline = '';
  if (!dragId) return;

  const task = tasks.find(t => t.id == dragId);
  if (!task || task.status === col) return;

  const oldStatus = task.status;
  task.status = col;
  renderBoard();

  try {
    await api('PATCH', `/tasks/${currentProject.id}/${dragId}`, { status: col }, { silent: true });
    toast(`Moved to ${STATUS_LABELS[col]}`, 'success');
  } catch {
    task.status = oldStatus;
    renderBoard();
    toast('Failed to move task', 'error');
  }
}

// ── CONTEXT MENU ──
function openCtxMenu(e, taskId) {
  ctxTaskId = taskId;
  const t = tasks.find(x => x.id == taskId);
  const menu = document.getElementById('ctx-menu');
  menu.innerHTML = `
    <div class="ctx-item" onclick="openTaskDetailFromCtx()">📋 View Details</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item" onclick="ctxMove('todo')">⬜ To Do</div>
    <div class="ctx-item" onclick="ctxMove('inprog')">🔵 In Progress</div>
    <div class="ctx-item" onclick="ctxMove('review')">🟡 Review</div>
    <div class="ctx-item" onclick="ctxMove('done')">✅ Done</div>
    <div class="ctx-sep"></div>
    <div class="ctx-item danger" onclick="ctxDelete()">🗑 Delete</div>`;
  positionMenu(menu, e.clientX, e.clientY);
  menu.classList.add('open');
}
function closeCtxMenu() { document.getElementById('ctx-menu').classList.remove('open'); }
function openTaskDetailFromCtx() { closeCtxMenu(); openTaskDetail(ctxTaskId); }
function ctxDelete() { closeCtxMenu(); deleteTask(ctxTaskId); }
async function ctxMove(col) {
  closeCtxMenu();
  const t = tasks.find(x => x.id == ctxTaskId);
  if (!t) return;
  const old = t.status;
  t.status = col;
  renderBoard();
  try {
    await api('PATCH', `/tasks/${currentProject.id}/${ctxTaskId}`, { status: col }, { silent: true });
    toast(`Moved to ${STATUS_LABELS[col]}`);
  } catch { t.status = old; renderBoard(); }
}

function positionMenu(menu, x, y) {
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth - 8) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
    if (r.bottom > window.innerHeight - 8) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
  });
}

// ══════════════════════════════════════════════════════════════
//  MEMBERS
// ══════════════════════════════════════════════════════════════
async function openMembersModal() {
  document.getElementById('members-modal').classList.add('open');
  document.getElementById('invite-result').innerHTML = '';
  document.getElementById('invite-email').value = '';
  await refreshMembersModal();
}
function closeMembersModal() { document.getElementById('members-modal').classList.remove('open'); }

async function refreshMembersModal() {
  try {
    const data = await api('GET', '/members/' + currentProject.id);
    if (!data) return;

    const list = document.getElementById('members-list');
    const allMembers = [data.owner, ...(data.members || [])];
    const isOwner = currentProject.owner_id === currentUser?.id;
    const isAdmin = isOwner || allMembers.find(m => m.id === currentUser?.id)?.role === 'admin';

    list.innerHTML = allMembers.map(m => {
      const isOnline = onlineUsers.has(m.id);
      const role = m.id === currentProject.owner_id ? 'owner' : (m.role || 'member');
      const canRemove = (isOwner || isAdmin) && m.id !== currentProject.owner_id && m.id !== currentUser?.id;
      return `<div class="member-row">
        <div class="member-av" style="${m.avatar ? '' : 'background:' + strToColor(m.name)}">
          ${m.avatar ? `<img src="${m.avatar}" alt=""/>` : getInitials(m.name)}
        </div>
        <div class="member-info">
          <div class="member-name">${esc(m.name)} ${m.id === currentUser?.id ? '<span style="font-size:10px;color:var(--text3)">(you)</span>' : ''}</div>
          <div class="member-email">${esc(m.email||'')}</div>
        </div>
        ${isOnline ? '<div class="member-online" title="Online"></div>' : ''}
        <span class="member-role ${role}">${role}</span>
        ${canRemove ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="removeMember('${m.id}')">Remove</button>` : ''}
      </div>`;
    }).join('');

    // Pending invites
    const pendingEl = document.getElementById('pending-invites-section');
    if (data.invites?.length) {
      pendingEl.innerHTML = `<div class="section-title" style="margin-bottom:8px">Pending Invites</div>` +
        data.invites.map(inv => `
          <div class="pending-invite-row">
            <span style="font-size:12px;font-family:var(--font-mono);color:var(--text2)">${esc(inv.email)}</span>
            <span style="font-size:10px;color:var(--text3)">${inv.role}</span>
            ${isAdmin ? `<button class="btn btn-ghost btn-sm btn-danger" onclick="revokeInvite('${inv.id}')">Revoke</button>` : ''}
          </div>`).join('');
    } else pendingEl.innerHTML = '';

    // Hide invite box if not admin
    document.getElementById('invite-box').style.display = isAdmin ? 'block' : 'none';
  } catch {}
}

async function sendInvite() {
  const email = document.getElementById('invite-email').value.trim();
  const role = document.getElementById('invite-role').value;
  if (!email) return;
  try {
    const data = await api('POST', `/members/${currentProject.id}/invite`, { email, role });
    if (!data) return;
    const resultEl = document.getElementById('invite-result');
    resultEl.innerHTML = `
      <div style="background:var(--accent-dim);border:1px solid rgba(200,255,87,0.2);border-radius:var(--r-sm);padding:10px">
        <div style="font-size:12px;font-weight:600;color:var(--accent);margin-bottom:6px">
          ${data.userFound ? '✓ User added to project!' : '✓ Invite created!'}
        </div>
        ${!data.userFound ? `
          <div style="font-size:11px;color:var(--text2);margin-bottom:6px">Share this link with <strong>${esc(email)}</strong>:</div>
          <div class="invite-link-box">
            <span class="invite-link-text" id="invite-link-text">${esc(data.inviteUrl)}</span>
            <button class="btn btn-sm" onclick="copyInviteLink('${esc(data.inviteUrl)}')">Copy</button>
          </div>` : ''}
      </div>`;
    document.getElementById('invite-email').value = '';
    await refreshMembersModal();
  } catch {}
}

function copyInviteLink(url) {
  navigator.clipboard.writeText(url).then(() => toast('Link copied!', 'success')).catch(() => toast('Copy failed', 'error'));
}

async function removeMember(userId) {
  if (!confirm('Remove this member from the project?')) return;
  try {
    await api('DELETE', `/members/${currentProject.id}/${userId}`);
    members = members.filter(m => m.id !== userId);
    await refreshMembersModal();
    toast('Member removed', 'success');
  } catch {}
}

async function revokeInvite(inviteId) {
  try {
    await api('DELETE', `/members/${currentProject.id}/invite/${inviteId}`);
    await refreshMembersModal();
    toast('Invite revoked', 'success');
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  ACTIVITY
// ══════════════════════════════════════════════════════════════
async function openActivityModal() {
  document.getElementById('activity-modal').classList.add('open');
  const list = document.getElementById('activity-list');
  list.innerHTML = `<div class="activity-item"><div class="skeleton" style="width:100%;height:40px"></div></div>`.repeat(5);
  try {
    const data = await api('GET', '/activity/' + currentProject.id);
    if (!data) return;
    list.innerHTML = '';
    if (!data.activities.length) {
      list.innerHTML = '<div style="text-align:center;padding:40px;color:var(--text3)">No activity yet</div>';
      return;
    }
    data.activities.forEach(a => {
      const div = document.createElement('div');
      div.className = 'activity-item';
      div.innerHTML = `
        <div class="activity-icon-wrap">${activityIcon(a.type)}</div>
        <div class="activity-body">
          <div class="activity-text">${activityText(a)}</div>
          <div class="activity-time">${timeAgo(a.created_at)}</div>
        </div>`;
      list.appendChild(div);
    });
  } catch {}
}
function closeActivityModal() { document.getElementById('activity-modal').classList.remove('open'); }

function activityIcon(type) {
  const m = { 'task:created':'➕','task:moved':'↔️','task:deleted':'🗑','task:updated':'✏️','comment:added':'💬','project:created':'🚀','project:updated':'⚙️','member:joined':'👋' };
  return m[type] || '•';
}
function activityText(a) {
  const who = `<strong>${esc(a.user_name||'Someone')}</strong>`;
  const task = a.task_title ? ` on <strong>"${esc(a.task_title)}"</strong>` : '';
  switch (a.type) {
    case 'task:created': return `${who} created task <strong>"${esc(a.meta?.title||'')}"</strong>`;
    case 'task:moved': return `${who} moved <strong>"${esc(a.meta?.title||'')}"</strong> from ${STATUS_LABELS[a.meta?.from]||''} → ${STATUS_LABELS[a.meta?.to]||''}`;
    case 'task:deleted': return `${who} deleted task "${esc(a.meta?.title||'')}"`;
    case 'comment:added': return `${who} commented${task}`;
    case 'project:created': return `${who} created this project`;
    case 'project:updated': return `${who} updated project settings`;
    default: return `${who} ${a.type.replace(':',' ')}`;
  }
}

// ══════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════
async function openStatsModal() {
  document.getElementById('stats-modal').classList.add('open');
  try {
    const data = await api('GET', '/activity/stats/' + currentProject.id);
    if (!data) return;
    const total = tasks.length;
    const done = tasks.filter(t => t.status === 'done').length;
    const pct = total ? Math.round(done/total*100) : 0;
    const high = tasks.filter(t => t.priority === 'high' && t.status !== 'done').length;

    const statusColors = { todo:'var(--text3)', inprog:'var(--blue)', review:'var(--amber)', done:'var(--teal)' };
    const maxStatus = Math.max(...(data.tasksByStatus.map(x => x.count)), 1);

    document.getElementById('stats-content').innerHTML = `
      <div class="stats-grid">
        <div class="stats-card"><div class="stats-card-label">Total Tasks</div><div class="stats-card-value">${total}</div><div class="stats-card-sub">${pct}% complete</div></div>
        <div class="stats-card"><div class="stats-card-label">Completed</div><div class="stats-card-value" style="color:var(--teal)">${done}</div><div class="stats-card-sub">tasks done</div></div>
        <div class="stats-card"><div class="stats-card-label">High Priority</div><div class="stats-card-value" style="color:var(--red)">${high}</div><div class="stats-card-sub">pending</div></div>
        <div class="stats-card"><div class="stats-card-label">Overdue</div><div class="stats-card-value" style="color:var(--amber)">${data.overdueTasks}</div><div class="stats-card-sub">past due date</div></div>
      </div>
      <div class="section-title" style="margin-bottom:12px">Tasks by Status</div>
      <div class="bar-chart" style="margin-bottom:20px">
        ${data.tasksByStatus.map(s => `
          <div class="bar-chart-row">
            <span class="bar-chart-label">${STATUS_LABELS[s.status]||s.status}</span>
            <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.round(s.count/maxStatus*100)}%;background:${statusColors[s.status]||'var(--accent)'}"></div></div>
            <span class="bar-chart-count">${s.count}</span>
          </div>`).join('')}
      </div>
      ${data.tasksByAssignee.length ? `
        <div class="section-title" style="margin-bottom:12px">Tasks by Member</div>
        <div class="bar-chart">
          ${data.tasksByAssignee.map(m => `
            <div class="bar-chart-row">
              <span class="bar-chart-label" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(m.name)}">${esc(m.name.split(' ')[0])}</span>
              <div class="bar-chart-track"><div class="bar-chart-fill" style="width:${Math.round(m.count/Math.max(...data.tasksByAssignee.map(x=>x.count),1)*100)}%;background:var(--purple)"></div></div>
              <span class="bar-chart-count">${m.count}</span>
            </div>`).join('')}
        </div>` : ''}`;
  } catch {}
}
function closeStatsModal() { document.getElementById('stats-modal').classList.remove('open'); }

// ══════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════════════════════
async function loadNotifications() {
  try {
    const data = await api('GET', '/activity/notifications/me', null, { silent: true });
    if (!data) return;
    const badge = document.getElementById('notif-badge');
    const list = document.getElementById('notif-list');

    if (data.unreadCount > 0) {
      badge.textContent = data.unreadCount > 9 ? '9+' : data.unreadCount;
      badge.classList.add('show');
    } else {
      badge.classList.remove('show');
    }

    if (!data.notifications.length) {
      list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
      return;
    }
    list.innerHTML = data.notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}" onclick="clickNotif('${n.id}','${n.link||''}')">
        <span class="notif-item-icon">${notifIcon(n.type)}</span>
        <div class="notif-item-body">
          <div class="notif-item-title">${esc(n.title)}</div>
          <div class="notif-item-text">${esc(n.body||'')}</div>
          <div class="notif-item-time">${timeAgo(n.created_at)}</div>
        </div>
        ${!n.read ? '<div class="notif-unread-dot"></div>' : ''}
      </div>`).join('');
  } catch {}
}

function notifIcon(type) {
  return { invited:'🎉', assigned:'👤', comment:'💬', mention:'@' }[type] || '🔔';
}

async function clickNotif(id, link) {
  await api('POST', `/activity/notifications/${id}/read`, null, { silent: true });
  toggleNotifDropdown();
  loadNotifications();
  if (link) {
    const match = link.match(/\/projects\/([^/]+)/);
    if (match) {
      const p = projects.find(x => x.id === match[1]);
      if (p) openProject(p.id);
    }
  }
}

async function markAllNotifRead() {
  await api('POST', '/activity/notifications/read-all', null, { silent: true });
  loadNotifications();
  toggleNotifDropdown();
}

// Refresh notifications every 30s
setInterval(loadNotifications, 30000);

function toggleNotifDropdown() {
  const dd = document.getElementById('notif-dropdown');
  notifDropdownOpen = !notifDropdownOpen;
  dd.classList.toggle('open', notifDropdownOpen);
  if (notifDropdownOpen) { userDropdownOpen = false; document.getElementById('user-dropdown').classList.remove('open'); }
}

// ══════════════════════════════════════════════════════════════
//  ONLINE PRESENCE
// ══════════════════════════════════════════════════════════════
function renderOnlinePresence() {
  const wrap = document.getElementById('online-presence');
  if (!currentProject) { wrap.style.display = 'none'; return; }
  const others = [...onlineUsers.values()].filter(u => u.userId !== currentUser?.id);
  if (!others.length) { wrap.innerHTML = '<div class="presence-dot" title="Only you here"></div>'; return; }
  wrap.style.display = 'flex';
  wrap.innerHTML = others.slice(0, 4).map(u => `
    <div class="presence-av" title="${esc(u.name)} (online)" style="${u.avatar ? '' : 'background:' + strToColor(u.name)}">
      ${u.avatar ? `<img src="${u.avatar}" alt=""/>` : getInitials(u.name)}
    </div>`).join('') +
    (others.length > 4 ? `<div class="presence-av" style="background:var(--surface3);color:var(--text3)">+${others.length-4}</div>` : '') +
    '<div class="presence-dot" title="Live"></div>';
}

// ══════════════════════════════════════════════════════════════
//  PROFILE
// ══════════════════════════════════════════════════════════════
function openProfileModal() {
  closeUserDropdown();
  document.getElementById('profile-name').value = currentUser.name;
  document.getElementById('profile-bio').value = currentUser.bio || '';
  document.getElementById('profile-email').value = currentUser.email;
  document.getElementById('profile-curpass').value = '';
  document.getElementById('profile-newpass').value = '';
  const av = document.getElementById('profile-av-large');
  if (currentUser.avatar) av.innerHTML = `<img src="${currentUser.avatar}" alt="av"/>`;
  else av.textContent = getInitials(currentUser.name);
  document.getElementById('profile-modal').classList.add('open');
  profileAvatarFile = null;
}
function closeProfileModal() { document.getElementById('profile-modal').classList.remove('open'); }

function handleProfileAvatarUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  profileAvatarFile = file;
  const reader = new FileReader();
  reader.onload = ev => { document.getElementById('profile-av-large').innerHTML = `<img src="${ev.target.result}" alt="av"/>`; };
  reader.readAsDataURL(file);
}

function handleRegAvatarUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  regAvatarFile = file;
  const reader = new FileReader();
  reader.onload = ev => {
    const prev = document.getElementById('reg-avatar-preview');
    prev.innerHTML = `<img src="${ev.target.result}" alt="av" style="width:100%;height:100%;object-fit:cover;border-radius:50%"/>`;
  };
  reader.readAsDataURL(file);
}

async function saveProfile() {
  const name = document.getElementById('profile-name').value.trim();
  const bio = document.getElementById('profile-bio').value.trim();
  const curpass = document.getElementById('profile-curpass').value;
  const newpass = document.getElementById('profile-newpass').value;
  if (!name) return;

  try {
    // Upload avatar first if changed
    if (profileAvatarFile) {
      const url = await uploadAvatar(profileAvatarFile);
      currentUser.avatar = url;
    }

    const body = { name, bio };
    if (newpass) { body.password = curpass; body.newPassword = newpass; }

    const data = await api('PATCH', '/auth/profile', body);
    if (!data) return;
    currentUser = { ...currentUser, ...data.user };
    refreshTopbarUser();
    closeProfileModal();
    toast('Profile saved!', 'success');
  } catch {}
}

// ══════════════════════════════════════════════════════════════
//  DROPDOWNS & UI
// ══════════════════════════════════════════════════════════════
function toggleUserDropdown() {
  userDropdownOpen = !userDropdownOpen;
  document.getElementById('user-dropdown').classList.toggle('open', userDropdownOpen);
  if (userDropdownOpen) { notifDropdownOpen = false; document.getElementById('notif-dropdown').classList.remove('open'); }
}
function closeUserDropdown() {
  userDropdownOpen = false;
  document.getElementById('user-dropdown').classList.remove('open');
}

document.addEventListener('click', e => {
  if (!document.getElementById('user-chip').contains(e.target)) { userDropdownOpen = false; document.getElementById('user-dropdown').classList.remove('open'); }
  if (!document.getElementById('notif-bell').contains(e.target) && !document.getElementById('notif-dropdown').contains(e.target)) { notifDropdownOpen = false; document.getElementById('notif-dropdown').classList.remove('open'); }
  if (!document.getElementById('ctx-menu').contains(e.target)) closeCtxMenu();
});

function openShortcutsPanel() { closeUserDropdown(); document.getElementById('kbd-panel').classList.add('open'); }
function closeShortcutsPanel() { document.getElementById('kbd-panel').classList.remove('open'); }

document.addEventListener('keydown', e => {
  const tag = document.activeElement.tagName;
  const typing = ['INPUT','TEXTAREA','SELECT'].includes(tag);

  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
    closeCtxMenu(); closeUserDropdown(); closeShortcutsPanel();
    return;
  }
  if (typing) return;
  if ((e.key === 'n' || e.key === 'N') && currentProject) openTaskModal();
  if (e.key === 'p' || e.key === 'P') openNewProjectModal();
  if (e.key === 'h' || e.key === 'H') goHome();
  if ((e.key === 'm' || e.key === 'M') && currentProject) openMembersModal();
  if ((e.key === 'a' || e.key === 'A') && currentProject) openActivityModal();
  if (e.key === '?') document.getElementById('kbd-panel').classList.toggle('open');
  if (e.key === '/') { e.preventDefault(); document.getElementById('search-input')?.focus(); }
});

// Enter key shortcuts
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('login-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('reg-password')?.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  document.getElementById('np-name')?.addEventListener('keydown', e => { if (e.key === 'Enter') createProject(); });
  document.getElementById('invite-email')?.addEventListener('keydown', e => { if (e.key === 'Enter') sendInvite(); });
});

// ══════════════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════════════
function toast(msg, type = '') {
  const c = document.getElementById('toast-container');
  const t = document.createElement('div');
  t.className = `toast${type ? ' ' + type : ''}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'info' ? 'ℹ' : '•';
  t.innerHTML = `<span>${icon}</span>${esc(msg)}`;
  c.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity 0.3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2800);
}

// ══════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function getInitials(name) {
  return (name||'?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0,2);
}
function strToColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  const colors = ['#2d4a1e','#1a2d4a','#3a1a4a','#4a2a1a','#1a3a3a','#3a1a2a','#2a3a1a'];
  return colors[Math.abs(hash) % colors.length];
}
function timeAgo(ts) {
  if (!ts) return '';
  const now = Date.now() / 1000;
  const sec = typeof ts === 'number' ? now - ts : now - (new Date(ts).getTime() / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return Math.floor(sec/60) + 'm ago';
  if (sec < 86400) return Math.floor(sec/3600) + 'h ago';
  if (sec < 604800) return Math.floor(sec/86400) + 'd ago';
  const d = new Date(typeof ts === 'number' ? ts * 1000 : ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
