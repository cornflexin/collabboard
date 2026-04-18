const express = require('express');
const db = require('../db');
const { requireAuth, requireProjectAccess } = require('../middleware/auth');

const router = express.Router();

// GET /api/activity/:projectId
router.get('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const offset = parseInt(req.query.offset) || 0;

  const activities = db.prepare(`
    SELECT a.*, u.name as user_name, u.avatar as user_avatar,
           t.title as task_title
    FROM activity a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.project_id = ?
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.project.id, limit, offset);

  const total = db.prepare('SELECT COUNT(*) as c FROM activity WHERE project_id=?').get(req.project.id);

  res.json({
    activities: activities.map(a => ({ ...a, meta: JSON.parse(a.meta || '{}') })),
    total: total.c,
    hasMore: offset + limit < total.c
  });
});

// GET /api/activity/notifications — user's notifications
router.get('/notifications/me', requireAuth, (req, res) => {
  const notifications = db.prepare(`
    SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50
  `).all(req.user.id);

  const unreadCount = db.prepare('SELECT COUNT(*) as c FROM notifications WHERE user_id=? AND read=0').get(req.user.id);

  res.json({ notifications, unreadCount: unreadCount.c });
});

// POST /api/activity/notifications/read-all
router.post('/notifications/read-all', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.user.id);
  res.json({ ok: true });
});

// POST /api/activity/notifications/:id/read
router.post('/notifications/:id/read', requireAuth, (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// GET /api/activity/stats/:projectId
router.get('/stats/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  const tasksByStatus = db.prepare(`
    SELECT status, COUNT(*) as count FROM tasks WHERE project_id=? GROUP BY status
  `).all(req.project.id);

  const tasksByPriority = db.prepare(`
    SELECT priority, COUNT(*) as count FROM tasks WHERE project_id=? GROUP BY priority
  `).all(req.project.id);

  const tasksByAssignee = db.prepare(`
    SELECT u.id, u.name, u.avatar, COUNT(t.id) as count
    FROM tasks t JOIN users u ON u.id=t.assignee_id
    WHERE t.project_id=? AND t.assignee_id IS NOT NULL
    GROUP BY t.assignee_id
  `).all(req.project.id);

  const completedOverTime = db.prepare(`
    SELECT date(completed_at, 'unixepoch') as day, COUNT(*) as count
    FROM tasks WHERE project_id=? AND status='done' AND completed_at IS NOT NULL
    GROUP BY day ORDER BY day DESC LIMIT 14
  `).all(req.project.id);

  const overdueTasks = db.prepare(`
    SELECT COUNT(*) as c FROM tasks
    WHERE project_id=? AND status != 'done' AND due_date < date('now') AND due_date IS NOT NULL
  `).get(req.project.id);

  res.json({
    tasksByStatus,
    tasksByPriority,
    tasksByAssignee,
    completedOverTime: completedOverTime.reverse(),
    overdueTasks: overdueTasks.c
  });
});

module.exports = router;
