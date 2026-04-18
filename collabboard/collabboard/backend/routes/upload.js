const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '../../uploads/avatars');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${req.user.id}_${Date.now()}${ext}`);
  }
});

const fileFilter = (req, file, cb) => {
  const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only images are allowed'), false);
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// POST /api/upload/avatar
router.post('/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Delete old avatar if it's a local file
  const user = db.prepare('SELECT avatar FROM users WHERE id=?').get(req.user.id);
  if (user?.avatar && user.avatar.startsWith('/uploads/')) {
    const oldPath = path.join(__dirname, '../../', user.avatar);
    if (fs.existsSync(oldPath)) {
      try { fs.unlinkSync(oldPath); } catch (e) {}
    }
  }

  const avatarUrl = `/uploads/avatars/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar=?, updated_at=unixepoch() WHERE id=?').run(avatarUrl, req.user.id);

  res.json({ avatarUrl });
});

// Error handler for multer
router.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'File too large (max 5MB)' });
  }
  res.status(400).json({ error: err.message });
});

module.exports = router;
