# Sample: React + Node + Postgres + WebSockets chat (F2 -- single EC2)

A Vite React frontend (`frontend/`) and an Express API (`backend/`, with its
own `Dockerfile`) that stores messages in Postgres and pushes new ones to every
browser over a WebSocket. WebSockets rule out Lambda, so AutoInfra routes it
to **F2**: one Free-Tier EC2 instance running the API, Postgres and Caddy with
Docker Compose, the frontend on S3, and CloudFront in front of both.

- `GET /api/health` -- checks the database too
- `GET /api/messages`, `POST /api/messages` -- stored in Postgres
- `WS /api/ws` -- live messages and an online count

`DATABASE_URL` is provided by AutoInfra (Postgres runs on the same instance).

## Run locally

```sh
docker run -d --name chat-db -p 5432:5432 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=app postgres:16-alpine
cd backend && npm ci && DATABASE_URL=postgresql://app:pw@localhost:5432/app npm start   # :4000
cd frontend && npm ci && npm run dev                                                     # :5173
```
