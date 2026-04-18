# CollabBoard — Fullstack Project Management

A production-ready, real-time collaborative project management app.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS + CSS (zero dependencies) |
| Backend | Node.js + Express |
| Database | SQLite (better-sqlite3, WAL mode) |
| Auth | bcryptjs (12 rounds) + JWT (7d expiry) |
| Real-time | WebSocket (ws library) |
| File storage | Multer (local disk, swappable to S3) |
| Security | Helmet, CORS, Rate limiting |

## Features

### Auth
- Secure registration with avatar upload
- bcrypt password hashing (cost factor 12)
- JWT sessions with 7-day expiry
- Session management (view & revoke active sessions)
- Profile editing with password change

### Projects
- Create, edit, archive, delete projects
- Custom icon + color per project
- Project stats: task counts by status
- Member presence overlay

### Board
- 4-column Kanban: To Do → In Progress → Review → Done
- Drag & drop between columns (optimistic UI, API sync)
- Right-click context menu
- Filters: All, High Priority, Mine, Overdue
- Live search across title, description, tags

### Tasks
- Full task detail modal with inline editing
- Priority (low/medium/high), tags, assignee, due date, estimated hours
- Checklist items with progress bar
- Comments with emoji reactions
- Real-time updates across all connected clients

### Collaboration
- WebSocket rooms per project
- Live presence (see who's online)
- Real-time task/comment sync across devices
- Invite teammates by email (with shareable invite link)
- Role-based access: owner / admin / member / viewer

### Notifications
- In-app notification center with unread badge
- Notifications for: assigned tasks, project invites, comments
- Mark all read / per-notification read

### Analytics
- Task breakdown by status, priority, assignee
- Overdue count
- Bar chart visualization

## Quick Start

```bash
# 1. Install dependencies
cd backend
npm install

# 2. Configure environment
cp .env.example .env
# Edit JWT_SECRET to a long random string!

# 3. Start server
node server.js

# 4. Open browser
open http://localhost:3001
```

## Directory Structure

```
collabboard/
├── backend/
│   ├── server.js          # Express + WebSocket server
│   ├── db.js              # SQLite schema & initialization
│   ├── middleware/
│   │   └── auth.js        # JWT verification middleware
│   └── routes/
│       ├── auth.js        # Register, login, profile, sessions
│       ├── projects.js    # Project CRUD
│       ├── tasks.js       # Task CRUD + comments
│       ├── members.js     # Invites, roles, member management
│       ├── activity.js    # Activity feed + notifications + stats
│       └── upload.js      # Avatar file upload
├── frontend/
│   ├── index.html         # Full SPA (HTML + CSS)
│   └── app.js             # JS: API client, WebSocket, UI logic
├── uploads/
│   └── avatars/           # Uploaded avatar images
└── data/
    └── collabboard.db     # SQLite database (auto-created)
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3001` |
| `JWT_SECRET` | JWT signing secret (change this!) | `cb_secret_2024` |
| `FRONTEND_URL` | CORS allowed origin | `*` |
| `NODE_ENV` | Environment | `development` |

## Security Notes

- Always change `JWT_SECRET` in production
- Avatar uploads limited to 5MB, images only
- Rate limited: 500 req/15min global, 20 req/15min on auth endpoints
- All passwords hashed with bcrypt (cost 12)
- SQL injection prevented via parameterized queries (better-sqlite3)
- XSS prevented via HTML escaping in frontend
- CSRF not applicable (JWT in Authorization header, not cookies)

## API Endpoints

### Auth
- `POST /api/auth/register` — Create account
- `POST /api/auth/login` — Sign in
- `POST /api/auth/logout` — Sign out
- `GET /api/auth/me` — Current user
- `PATCH /api/auth/profile` — Update profile
- `GET /api/auth/sessions` — Active sessions
- `POST /api/auth/invite/accept` — Accept project invite

### Projects
- `GET /api/projects` — All projects
- `POST /api/projects` — Create project
- `GET /api/projects/:id` — Get project
- `PATCH /api/projects/:id` — Update project
- `DELETE /api/projects/:id` — Delete project

### Tasks
- `GET /api/tasks/:projectId` — Get all tasks (filterable)
- `POST /api/tasks/:projectId` — Create task
- `PATCH /api/tasks/:projectId/:taskId` — Update task
- `DELETE /api/tasks/:projectId/:taskId` — Delete task
- `POST /api/tasks/:projectId/reorder` — Bulk reorder
- `GET /api/tasks/:projectId/:taskId/comments` — Get comments
- `POST /api/tasks/:projectId/:taskId/comments` — Add comment
- `PATCH /api/tasks/:projectId/:taskId/comments/:commentId` — Edit/react
- `DELETE /api/tasks/:projectId/:taskId/comments/:commentId` — Delete comment

### Members
- `GET /api/members/:projectId` — List members + invites
- `POST /api/members/:projectId/invite` — Send invite
- `DELETE /api/members/:projectId/:userId` — Remove member
- `PATCH /api/members/:projectId/:userId/role` — Change role
- `DELETE /api/members/:projectId/invite/:inviteId` — Revoke invite

### Activity & Notifications
- `GET /api/activity/:projectId` — Activity feed
- `GET /api/activity/stats/:projectId` — Analytics
- `GET /api/activity/notifications/me` — My notifications
- `POST /api/activity/notifications/read-all` — Mark all read

### Upload
- `POST /api/upload/avatar` — Upload avatar image

### WebSocket Events

Connect to `ws://localhost:3001/ws` and send:
```json
{ "type": "auth", "payload": { "token": "<jwt>" } }
{ "type": "join", "payload": { "projectId": "..." } }
{ "type": "leave" }
```

Server broadcasts: `task:created`, `task:updated`, `task:deleted`, `tasks:reordered`, `comment:added`, `comment:deleted`, `comment:reacted`, `user:join`, `user:leave`, `room:online`, `project:updated`, `member:joined`, `member:removed`
