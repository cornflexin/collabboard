const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, requireProjectAccess, requireProjectAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/members/:projectId
router.get('/:projectId', requireAuth, requireProjectAccess, (req, res) => {
  const members = db.prepare(`
    SELECT u.id, u.name, u.avatar, u.email, u.last_seen, pm.role, pm.joined_at
    FROM users u
    JOIN project_members pm ON pm.user_id = u.id
    WHERE pm.project_id = ?
    ORDER BY pm.joined_at ASC
  `).all(req.project.id);

  const owner = db.prepare('SELECT id, name, avatar, email, last_seen FROM users WHERE id=?').get(req.project.owner_id);

  const invites = db.prepare(`
    SELECT * FROM invites WHERE project_id=? AND status='pending' ORDER BY created_at DESC
  `).all(req.project.id);

  res.json({
    owner: { ...owner, role: 'owner' },
    members,
    invites
  });
});

// POST /api/members/:projectId/invite
router.post('/:projectId/invite', requireAuth, requireProjectAccess, (req, res) => {
  if (req.memberRole !== 'owner' && req.memberRole !== 'admin') {
    return res.status(403).json({ error: 'Only admins can invite' });
  }

  const { email, role } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  // Check if user exists
  const invitedUser = db.prepare('SELECT * FROM users WHERE email=?').get(email.toLowerCase().trim());

  // Check if already a member
  if (invitedUser) {
    const alreadyMember = db.prepare('SELECT id FROM project_members WHERE project_id=? AND user_id=?').get(req.project.id, invitedUser.id);
    const isOwner = req.project.owner_id === invitedUser.id;
    if (alreadyMember || isOwner) return res.status(409).json({ error: 'User is already a member' });
  }

  // Check existing pending invite
  const existingInvite = db.prepare('SELECT id FROM invites WHERE project_id=? AND email=? AND status="pending"').get(req.project.id, email.toLowerCase().trim());
  if (existingInvite) return res.status(409).json({ error: 'Invite already sent to this email' });

  const token = uuid() + uuid();
  const id = uuid();
  const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600; // 7 days

  db.prepare(`
    INSERT INTO invites (id, project_id, email, token, role, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.project.id, email.toLowerCase().trim(), token, role || 'member', req.user.id, expiresAt);

  // If user exists, add them immediately and notify
  if (invitedUser) {
    db.prepare(`
      INSERT OR IGNORE INTO project_members (id, project_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), req.project.id, invitedUser.id, role || 'member', req.user.id);

    db.prepare('UPDATE invites SET status="accepted", accepted_at=unixepoch() WHERE id=?').run(id);

    db.prepare(`
      INSERT INTO notifications (id, user_id, type, title, body, link)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuid(), invitedUser.id, 'invited',
      `Invited to "${req.project.name}"`,
      `${req.user.name} added you to ${req.project.name}`,
      `/projects/${req.project.id}`
    );

    req.app.locals.broadcast(req.project.id, 'member:joined', {
      id: invitedUser.id, name: invitedUser.name, avatar: invitedUser.avatar, role: role || 'member'
    });
  }

  // Return the invite token (in production this would be emailed)
  res.status(201).json({
    invite: { id, token, email, role: role || 'member', expiresAt },
    inviteUrl: `${req.headers.origin || 'http://localhost:3001'}/invite/${token}`,
    userFound: !!invitedUser
  });
});

// DELETE /api/members/:projectId/:userId — remove member
router.delete('/:projectId/:userId', requireAuth, requireProjectAccess, (req, res) => {
  const targetId = req.params.userId;

  // Can remove yourself (leave) OR admin can remove others
  const isSelf = req.user.id === targetId;
  const isAdmin = req.memberRole === 'owner' || req.memberRole === 'admin';

  if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Cannot remove this member' });
  if (req.project.owner_id === targetId) return res.status(400).json({ error: 'Cannot remove project owner' });

  db.prepare('DELETE FROM project_members WHERE project_id=? AND user_id=?').run(req.project.id, targetId);
  req.app.locals.broadcast(req.project.id, 'member:removed', { userId: targetId });
  res.json({ ok: true });
});

// PATCH /api/members/:projectId/:userId/role
router.patch('/:projectId/:userId/role', requireAuth, requireProjectAccess, (req, res) => {
  if (req.memberRole !== 'owner') return res.status(403).json({ error: 'Only owner can change roles' });
  const { role } = req.body;
  if (!['admin','member','viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });

  db.prepare('UPDATE project_members SET role=? WHERE project_id=? AND user_id=?').run(role, req.project.id, req.params.userId);
  res.json({ ok: true });
});

// DELETE /api/members/:projectId/invite/:inviteId
router.delete('/:projectId/invite/:inviteId', requireAuth, requireProjectAccess, (req, res) => {
  if (req.memberRole !== 'owner' && req.memberRole !== 'admin') return res.status(403).json({ error: 'Admin required' });
  db.prepare('UPDATE invites SET status="revoked" WHERE id=? AND project_id=?').run(req.params.inviteId, req.project.id);
  res.json({ ok: true });
});

module.exports = router;
