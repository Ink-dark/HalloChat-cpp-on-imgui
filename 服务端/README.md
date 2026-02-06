# HalloChat Server

## Start
1. Install dependencies
   ```bash
   npm install
   ```
2. Run dev server
   ```bash
   npm run dev
   ```

## Environment
- `PORT` (default 3001)
- `WS_PATH` (default `/ws`)
- `ALLOWED_ORIGIN` (default `http://localhost:5173`)

## Endpoints
- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/friends/add` (Bearer token)
- `GET /api/friends/list` (Bearer token)
- `GET /health`
- `GET /stats`
- `GET /metrics`
- `WebSocket /ws`

## Storage
- Accounts stored in `data/users.json`
- Passwords are hashed (PBKDF2)

## WebSocket Protocol
- Client -> Server
  - `{ "type": "auth", "token": "..." }`
  - `{ "type": "message", "text": "Hello" }`
  - `{ "type": "private", "toUid": "...", "text": "Hi" }`
- Server -> Client
  - `{ "type": "system", "message": "..." }`
  - `{ "type": "message", "uid": "...", "name": "Alice", "text": "...", "ts": 1700000000000 }`
  - `{ "type": "private", "fromUid": "...", "fromName": "...", "toUid": "...", "text": "...", "ts": 1700000000000 }`
