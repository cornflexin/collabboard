const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, requireProjectAccess } = require('../middleware/auth');

const router = express.Router();

function logActivity(projectId, userId, type, meta = {}, taskId = null) {
  db.prepare(`
    INSERT INTO activity (id, project_id, user_id, task_id, type, meta)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), projectId, userId, taskId, type, JSON.stringify(meta));
}

function enrichTask(task) {
  if (!task) return null;
  const assignee = task.assignee_id
    ? db.prepare('SELECT id, name, avatar FROM users WHERE id=?').get(task.assignee_id)
    : null;
  const reporter = task.reporter_id
    ? db.prepare('SELECT id, name, avatar FROM users WHERE id=?').get(task.reporter_id)
    : null;
  const commentCount = db.prepare('SELECT COUNT(*) as c FROM comments WHERE task_id=?').get(task.id);
  return {
    ...task,
    tags: JSON.parse(task.tags || '[]'),
    checklist: JSON.parse(task.checklist || '[]'),
    attachments: JSON.parse(task.attachments || '[]'),
    assignee,
    reporter,
    commentCount: commentCount.c
  };
}

// GET /api/tasks/:projectId
router.get('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  const { status, priority, assignee, search } = req.query;

  let query = 'SELECT * FROM tasks WHERE project_id=?';
  const params = [req.project.id];

  if (status) { query += ' AND status=?'; params.push(status); }
  if (priority) { query += ' AND priority=?'; params.push(priority); }
  if (assignee) { query += ' AND assignee_id=?'; params.push(assignee); }
  if (search) { query += ' AND (title LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  query += ' ORDER BY position ASC, created_at ASC';

  const tasks = db.prepare(query).all(...params).map(enrichTask);
  res.json({ tasks });
});

// POST /api/tasks/:projectId
router.post('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  const { title, description, status, priority, tags, assignee_id, due_date, checklist, cover_color, estimated_hours } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: 'Title required' });

  // Compute position (put at end of column)
  const maxPos = db.prepare('SELECT MAX(position) as m FROM tasks WHERE project_id=? AND status=?').get(req.project.id, status || 'todo');

  const id = uuid();
  db.prepare(`
    INSERT INTO tasks (id, project_id, title, description, status, priority, tags, assignee_id, reporter_id, due_date, checklist, cover_color, estimated_hours, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, req.project.id,
    title.trim(),
    description?.trim() || null,
    status || 'todo',
    priority || 'medium',
    JSON.stringify(tags || []),
    assignee_id || null,
    req.user.id,
    due_date || null,
    JSON.stringify(checklist || []),
    cover_color || null,
    estimated_hours || null,
    (maxPos.m || 0) + 1000
  );

  const task = enrichTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));

  logActivity(req.project.id, req.user.id, 'task:created', { title: task.title }, id);

  // Notify assignee
  if (assignee_id && assignee_id !== req.user.id) {
    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuid(), assignee_id, 'assigned',
      `Assigned to "${task.title}"`,
      `${req.user.name} assigned you a task in ${req.project.name}`,
      `/projects/${req.project.id}`
    );
  }

  req.app.locals.broadcast(req.project.id, 'task:created', task);
  res.status(201).json({ task });
});

// PATCH /api/tasks/:projectId/:taskId
router.patch('/:projectId/:taskId', requireAuth, requireProjectAccess, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(req.params.taskId, req.project.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const allowed = ['title','description','status','priority','tags','assignee_id','due_date','checklist','cover_color','estimated_hours','position'];
  const updates = ['updated_at=unixepoch()'];
  const params = [];

  for (const field of allowed) {
    if (req.body[field] !== undefined) {
      updates.push(`${field}=?`);
      const val = ['tags','checklist','attachments'].includes(field)
        ? JSON.stringify(req.body[field])
        : req.body[field];
      params.push(val);
    }
  }

  // Mark completed_at
  if (req.body.status === 'done' && task.status !== 'done') {
    updates.push('completed_at=unixepoch()');
  } else if (req.body.status && req.body.status !== 'done' && task.status === 'done') {
    updates.push('completed_at=NULL');
  }

  params.push(task.id);
  db.prepare(`UPDATE tasks SET ${updates.join(',')} WHERE id=?`).run(...params);

  // Log status change
  if (req.body.status && req.body.status !== task.status) {
    logActivity(req.project.id, req.user.id, 'task:moved', {
      from: task.status, to: req.body.status, title: task.title
    }, task.id);
  }

  const updated = enrichTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
  req.app.locals.broadcast(req.project.id, 'task:updated', updated);
  res.json({ task: updated });
});

// DELETE /api/tasks/:projectId/:taskId
router.delete('/:projectId/:taskId', requireAuth, requireProjectAccess, (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(req.params.taskId, req.project.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  db.prepare('DELETE FROM tasks WHERE id=?').run(task.id);
  logActivity(req.project.id, req.user.id, 'task:deleted', { title: task.title });
  req.app.locals.broadcast(req.project.id, 'task:deleted', { id: task.id });
  res.json({ ok: true });
});

// POST /api/tasks/:projectId/:taskId/reorder — bulk reorder
router.post('/:projectId/reorder', requireAuth, requireProjectAccess, (req, res) => {
  const { order } = req.body; // [{id, position}]
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });

  const update = db.prepare('UPDATE tasks SET position=?, status=?, updated_at=unixepoch() WHERE id=? AND project_id=?');
  const updateMany = db.transaction((items) => {
    for (const item of items) {
      update.run(item.position, item.status, item.id, req.project.id);
    }
  });
  updateMany(order);

  req.app.locals.broadcast(req.project.id, 'tasks:reordered', { order });
  res.json({ ok: true });
});

// ── COMMENTS ──────────────────────────────────────────────

// GET /api/tasks/:projectId/:taskId/comments
router.get('/:projectId/:taskId/comments', requireAuth, requireProjectAccess, (req, res) => {
  const comments = db.prepare(`
    SELECT c.*, u.name as user_name, u.avatar as user_avatar
    FROM comments c JOIN users u ON u.id=c.user_id
    WHERE c.task_id=? ORDER BY c.created_at ASC
  `).all(req.params.taskId);

  res.json({ comments: comments.map(c => ({ ...c, reactions: JSON.parse(c.reactions || '{}') })) });
});

// POST /api/tasks/:projectId/:taskId/comments
router.post('/:projectId/:taskId/comments', requireAuth, requireProjectAccess, (req, res) => {
  const { body } = req.body;
  if (!body?.trim()) return res.status(400).json({ error: 'Comment body required' });

  const task = db.prepare('SELECT * FROM tasks WHERE id=? AND project_id=?').get(req.params.taskId, req.project.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const id = uuid();
  db.prepare('INSERT INTO comments (id, task_id, user_id, body) VALUES (?, ?, ?, ?)').run(id, task.id, req.user.id, body.trim());

  logActivity(req.project.id, req.user.id, 'comment:added', { taskTitle: task.title }, task.id);

  const comment = db.prepare(`
    SELECT c.*, u.name as user_name, u.avatar as user_avatar
    FROM comments c JOIN users u ON u.id=c.user_id WHERE c.id=?
  `).get(id);

  req.app.locals.broadcast(req.project.id, 'comment:added', { taskId: task.id, comment: { ...comment, reactions: {} } });
  res.status(201).json({ comment: { ...comment, reactions: {} } });
});

// PATCH /api/tasks/:projectId/:taskId/comments/:commentId
router.patch('/:projectId/:taskId/comments/:commentId', requireAuth, requireProjectAccess, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id=? AND user_id=?').get(req.params.commentId, req.user.id);
  if (!comment) return res.status(404).json({ error: 'Comment not found or not yours' });

  const { body, reaction } = req.body;

  if (reaction) {
    const reactions = JSON.parse(comment.reactions || '{}');
    if (!reactions[reaction]) reactions[reaction] = [];
    const idx = reactions[reaction].indexOf(req.user.id);
    if (idx === -1) reactions[reaction].push(req.user.id);
    else reactions[reaction].splice(idx, 1);
    db.prepare('UPDATE comments SET reactions=? WHERE id=?').run(JSON.stringify(reactions), comment.id);
    req.app.locals.broadcast(req.project.id, 'comment:reacted', { commentId: comment.id, reactions });
    return res.json({ ok: true, reactions });
  }

  if (body?.trim()) {
    db.prepare('UPDATE comments SET body=?, edited=1, updated_at=unixepoch() WHERE id=?').run(body.trim(), comment.id);
  }

  res.json({ ok: true });
});

// DELETE /api/tasks/:projectId/:taskId/comments/:commentId
router.delete('/:projectId/:taskId/comments/:commentId', requireAuth, requireProjectAccess, (req, res) => {
  const comment = db.prepare('SELECT * FROM comments WHERE id=?').get(req.params.commentId);
  if (!comment) return res.status(404).json({ error: 'Not found' });
  // Allow comment author or project admin
  if (comment.user_id !== req.user.id && req.memberRole !== 'owner' && req.memberRole !== 'admin') {
    return res.status(403).json({ error: 'Cannot delete this comment' });
  }
  db.prepare('DELETE FROM comments WHERE id=?').run(comment.id);
  req.app.locals.broadcast(req.project.id, 'comment:deleted', { taskId: req.params.taskId, commentId: comment.id });
  res.json({ ok: true });
});

module.exports = router;
