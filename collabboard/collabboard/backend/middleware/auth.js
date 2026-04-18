const jwt = require('jsonwebtoken');
const db = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'cb_secret_2024';

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = header.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT id, email, name, avatar, bio, role, created_at FROM users WHERE id=? AND is_active=1').get(decoded.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });

    // Update last_seen
    db.prepare('UPDATE users SET last_seen=unixepoch() WHERE id=?').run(user.id);

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireProjectAccess(req, res, next) {
  const projectId = req.params.projectId || req.body.projectId || req.query.projectId;
  if (!projectId) return res.status(400).json({ error: 'Project ID required' });

  const project = db.prepare('SELECT * FROM projects WHERE id=?').get(projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (project.owner_id === req.user.id) {
    req.project = project;
    req.memberRole = 'owner';
    return next();
  }

  const member = db.prepare('SELECT * FROM project_members WHERE project_id=? AND user_id=?').get(projectId, req.user.id);
  if (!member) return res.status(403).json({ error: 'Access denied' });

  req.project = project;
  req.memberRole = member.role;
  next();
}

function requireProjectAdmin(req, res, next) {
  requireProjectAccess(req, res, () => {
    if (req.memberRole !== 'owner' && req.memberRole !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireProjectAccess, requireProjectAdmin };
