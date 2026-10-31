# Sample: React + Express notes app (F1 -- serverless)

A Vite React frontend (`frontend/`) and an Express API (`backend/`) with read
and write routes. AutoInfra routes it to **F1**: the frontend on S3 +
CloudFront, the API on Lambda behind the Lambda Web Adapter, with CloudFront
sending `/api/*` to the Lambda Function URL.

- `GET /api/health` -- health check
- `GET /api/notes`, `POST /api/notes` -- in-memory notes (reset when Lambda
  starts a fresh instance; this sample is about request/response, not storage)

Because the API has a `POST` route, AutoInfra uses a public Function URL with
CloudFront in front (signed CloudFront-to-Lambda access breaks browser
writes).

## Run locally

```sh
cd backend && npm ci && npm start          # http://localhost:8080
cd frontend && npm ci && npm run dev       # http://localhost:5173 (proxies /api)
```
