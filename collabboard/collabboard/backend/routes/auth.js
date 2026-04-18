const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'cb_secret_2024';
const JWT_EXPIRES = '7d';

function makeToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function safeUser(u) {
  return { id: u.id, email: u.email, name: u.name, avatar: u.avatar, bio: u.bio, role: u.role, created_at: u.created_at };
}

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Invalid email' });
  if (name.trim().length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });

  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 12);
  const id = uuid();

  db.prepare(`
    INSERT INTO users (id, email, name, password) VALUES (?, ?, ?, ?)
  `).run(id, email.toLowerCase().trim(), name.trim(), hash);

  const token = makeToken(id);

  // Log session
  db.prepare(`
    INSERT INTO sessions (id, user_id, token, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), id, token, Date.now() + 7 * 24 * 3600 * 1000, req.ip, req.headers['user-agent']);

  const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  res.status(201).json({ token, user: safeUser(user) });
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare('SELECT * FROM users WHERE email=? AND is_active=1').get(email.toLowerCase().trim());
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  const token = makeToken(user.id);

  db.prepare(`
    INSERT INTO sessions (id, user_id, token, expires_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(uuid(), user.id, token, Date.now() + 7 * 24 * 3600 * 1000, req.ip, req.headers['user-agent']);

  db.prepare('UPDATE users SET last_seen=unixepoch() WHERE id=?').run(user.id);

  res.json({ token, user: safeUser(user) });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  const token = req.headers.authorization?.slice(7);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: safeUser(user) });
});

// PATCH /api/auth/profile
router.patch('/profile', requireAuth, async (req, res) => {
  const { name, bio, password, newPassword } = req.body;
  const updates = [];
  const params = [];

  if (name && name.trim().length >= 2) { updates.push('name=?'); params.push(name.trim()); }
  if (bio !== undefined) { updates.push('bio=?'); params.push(bio); }
  if (newPassword) {
    if (!password) return res.status(400).json({ error: 'Current password required to set new password' });
    const user = db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ error: 'Current password incorrect' });
    if (newPassword.length < 6) return res.status(400).json({ error: 'New password too short' });
    const hash = await bcrypt.hash(newPassword, 12);
    updates.push('password=?');
    params.push(hash);
  }

  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  updates.push('updated_at=unixepoch()');
  params.push(req.user.id);

  db.prepare(`UPDATE users SET ${updates.join(',')} WHERE id=?`).run(...params);
  const updated = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: safeUser(updated) });
});

// GET /api/auth/sessions
router.get('/sessions', requireAuth, (req, res) => {
  const sessions = db.prepare(`
    SELECT id, created_at, expires_at, ip, user_agent FROM sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 10
  `).all(req.user.id);
  res.json({ sessions });
});

// DELETE /api/auth/sessions/:id
router.delete('/sessions/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// POST /api/auth/invite/accept
router.post('/invite/accept', requireAuth, (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const invite = db.prepare('SELECT * FROM invites WHERE token=? AND status="pending" AND expires_at > unixepoch()').get(token);
  if (!invite) return res.status(404).json({ error: 'Invite not found or expired' });

  // Check not already a member
  const existing = db.prepare('SELECT id FROM project_members WHERE project_id=? AND user_id=?').get(invite.project_id, req.user.id);
  if (!existing) {
    db.prepare(`
      INSERT INTO project_members (id, project_id, user_id, role, invited_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(uuid(), invite.project_id, req.user.id, invite.role, invite.invited_by);
  }

  db.prepare('UPDATE invites SET status="accepted", accepted_at=unixepoch() WHERE id=?').run(invite.id);

  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(invite.project_id);
  res.json({ ok: true, project });
});

module.exports = router;
