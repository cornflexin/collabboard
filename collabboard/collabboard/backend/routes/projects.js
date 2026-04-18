const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, requireProjectAccess, requireProjectAdmin } = require('../middleware/auth');

const router = express.Router();

function logActivity(projectId, userId, type, meta = {}, taskId = null) {
  db.prepare(`
    INSERT INTO activity (id, project_id, user_id, task_id, type, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), projectId, userId, taskId, type, JSON.stringify(meta));
}

// GET /api/projects — all projects for current user
router.get('/', requireAuth, (req, res) => {
  const owned = db.prepare('SELECT * FROM projects WHERE owner_id=? AND is_archived=0 ORDER BY updated_at DESC').all(req.user.id);
  const memberOf = db.prepare(`
    SELECT p.* FROM projects p
    JOIN project_members pm ON pm.project_id=p.id
    WHERE pm.user_id=? AND p.is_archived=0 AND p.owner_id != ?
    ORDER BY p.updated_at DESC
  `).all(req.user.id, req.user.id);

  const enrichProject = (p) => {
    const taskCounts = db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks WHERE project_id=? GROUP BY status
    `).all(p.id);
    const counts = {};
    taskCounts.forEach(r => counts[r.status] = r.count);

    const members = db.prepare(`
      SELECT u.id, u.name, u.avatar FROM users u
      JOIN project_members pm ON pm.user_id=u.id
      WHERE pm.project_id=?
    `).all(p.id);

    const owner = db.prepare('SELECT id, name, avatar FROM users WHERE id=?').get(p.owner_id);

    return {
      ...p,
      settings: JSON.parse(p.settings || '{}'),
      taskCounts: counts,
      totalTasks: Object.values(counts).reduce((a, b) => a + b, 0),
      members: [owner, ...members.filter(m => m.id !== p.owner_id)],
      isOwner: true
    };
  };

  res.json({
    projects: [
      ...owned.map(p => ({ ...enrichProject(p), isOwner: true })),
      ...memberOf.map(p => ({ ...enrichProject(p), isOwner: false }))
    ]
  });
});

// POST /api/projects
router.post('/', requireAuth, (req, res) => {
  const { name, description, icon, color } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Project name required' });

  const id = uuid();
  db.prepare(`
    INSERT INTO projects (id, name, description, icon, color, owner_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name.trim(), description?.trim() || '', icon || '📋', color || '#c8ff57', req.user.id);

  logActivity(id, req.user.id, 'project:created', { name: name.trim() });

  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  res.status(201).json({ project: { ...project, settings: JSON.parse(project.settings || '{}'), members: [], taskCounts: {}, totalTasks: 0, isOwner: true } });
});

// GET /api/projects/:projectId
router.get('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  const p = req.project;
  const members = db.prepare(`
    SELECT u.id, u.name, u.avatar, u.email, pm.role, pm.joined_at
    FROM users u JOIN project_members pm ON pm.user_id=u.id
    WHERE pm.project_id=?
  `).all(p.id);

  const owner = db.prepare('SELECT id, name, avatar, email FROM users WHERE id=?').get(p.owner_id);
  const taskCounts = db.prepare('SELECT status, COUNT(*) as count FROM tasks WHERE project_id=? GROUP BY status').all(p.id);
  const counts = {};
  taskCounts.forEach(r => counts[r.status] = r.count);

  res.json({
    project: {
      ...p,
      settings: JSON.parse(p.settings || '{}'),
      members: [{ ...owner, role: 'owner' }, ...members],
      taskCounts: counts,
      totalTasks: Object.values(counts).reduce((a, b) => a + b, 0),
      isOwner: p.owner_id === req.user.id,
      memberRole: req.memberRole
    }
  });
});

// PATCH /api/projects/:projectId
router.patch('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  if (req.memberRole !== 'owner' && req.memberRole !== 'admin') {
    return res.status(403).json({ error: 'Admin required' });
  }
  const { name, description, icon, color, settings } = req.body;
  const updates = ['updated_at=unixepoch()'];
  const params = [];

  if (name) { updates.push('name=?'); params.push(name.trim()); }
  if (description !== undefined) { updates.push('description=?'); params.push(description); }
  if (icon) { updates.push('icon=?'); params.push(icon); }
  if (color) { updates.push('color=?'); params.push(color); }
  if (settings) { updates.push('settings=?'); params.push(JSON.stringify(settings)); }

  params.push(req.project.id);
  db.prepare(`UPDATE projects SET ${updates.join(',')} WHERE id=?`).run(...params);

  logActivity(req.project.id, req.user.id, 'project:updated', { name });

  const updated = db.prepare('SELECT * FROM projects WHERE id=?').get(req.project.id);
  req.app.locals.broadcast(req.project.id, 'project:updated', updated, null);
  res.json({ project: { ...updated, settings: JSON.parse(updated.settings || '{}') } });
});

// DELETE /api/projects/:projectId
router.delete('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  if (req.project.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only owner can delete project' });
  }
  db.prepare('DELETE FROM projects WHERE id=?').run(req.project.id);
  res.json({ ok: true });
});

// POST /api/projects/:projectId/archive
router.post('/:projectId/archive', requireAuth, requireProjectAccess, (req, res) => {
  if (req.project.owner_id !== req.user.id) return res.status(403).json({ error: 'Owner only' });
  db.prepare('UPDATE projects SET is_archived=1, updated_at=unixepoch() WHERE id=?').run(req.project.id);
  res.json({ ok: true });
});

module.exports = router;
