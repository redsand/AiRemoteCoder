# Operations Guide

## Directory Structure

```
.data/
├── db.sqlite          # SQLite database
├── certs/             # TLS certificates
│   ├── server.crt
│   └── server.key
├── artifacts/         # Uploaded artifacts per run
│   └── <run-id>/
│       └── <artifact-id>_<filename>
└── runs/              # Local run logs
    └── <run-id>/
        └── claude.log
```

All runtime data is stored under `.data/` in the project root.

---

## Database

### Location
`.data/db.sqlite`

### Schema

#### runs
- `id` - TEXT PRIMARY KEY (UUID)
- `status` - TEXT (pending|running|completed|failed|cancelled)
- `prompt` - TEXT
- `result` - TEXT
- `error` - TEXT
- `model` - TEXT
- `started_at` - TEXT (ISO 8601)
- `completed_at` - TEXT (ISO 8601)
- `artifact_count` - INTEGER (default 0)

#### clients
- `id` - TEXT PRIMARY KEY (UUID)
- `name` - TEXT
- `api_key` - TEXT (hashed)
- `created_at` - TEXT (ISO 8601)
- `last_active` - TEXT (ISO 8601)

#### artifacts
- `id` - TEXT PRIMARY KEY (UUID)
- `run_id` - TEXT (FK: runs.id)
- `filename` - TEXT
- `size` - INTEGER
- `content_type` - TEXT
- `path` - TEXT (storage path)
- `created_at` - TEXT (ISO 8601)

#### alerts
- `id` - TEXT PRIMARY KEY (UUID)
- `type` - TEXT (error|warning|info)
- `message` - TEXT
- `run_id` - TEXT (FK: runs.id, nullable)
- `created_at` - TEXT (ISO 8601)
- `read` - INTEGER (0|1)

---

## API Routes

### Authentication

All API endpoints (except `/api/auth/login`) require authentication via:
- Header: `Authorization: Bearer <api-key>`
- Or query parameter: `?api_key=<api-key>`

---

### Authentication Routes

#### POST `/api/auth/login`
Authenticates a client and returns an API key.

**Request Body:**
```json
{
  "name": "client-name"
}
```

**Response (200 OK):**
```json
{
  "id": "client-uuid",
  "name": "client-name",
  "api_key": "sk-..."
}
```

**Response (409 Conflict):**
```json
{
  "error": "Client already exists"
}
```



---

### Client Routes

#### GET `/api/clients`
Retrieve all registered clients.

**Authentication:** Required

**Query Parameters:**
- `limit` - Maximum number of results (default: 50)
- `offset` - Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "clients": [
    {
      "id": "client-uuid",
      "name": "client-name",
      "created_at": "2024-01-01T00:00:00Z",
      "last_active": "2024-01-01T00:00:00Z"
    }
  ],
  "total": 1
}
```

#### GET `/api/clients/:id`
Retrieve a specific client by ID.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "client-uuid",
  "name": "client-name",
  "created_at": "2024-01-01T00:00:00Z",
  "last_active": "2024-01-01T00:00:00Z"
}
```

**Response (404 Not Found):**
```json
{
  "error": "Client not found"
}
```

#### PATCH `/api/clients/:id`
Update a client's information.

**Authentication:** Required

**Request Body:**
```json
{
  "name": "new-client-name"
}
```

**Response (200 OK):**
```json
{
  "id": "client-uuid",
  "name": "new-client-name",
  "created_at": "2024-01-01T00:00:00Z",
  "last_active": "2024-01-01T00:00:00Z"
}
```

#### DELETE `/api/clients/:id`
Delete a client and revoke their API key.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "message": "Client deleted successfully"
}
```

#### POST `/api/clients/:id/rotate-key`
Rotate a client's API key.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "api_key": "sk-new-key..."
}
```

---

### Run Routes

#### POST `/api/runs`
Create a new code execution run.

**Authentication:** Required

**Request Body:**
```json
{
  "prompt": "your task description",
  "model": "claude-sonnet-4-20250514",
  "options": {
    "timeout": 300,
    "max_tokens": 4096
  }
}
```

**Response (201 Created):**
```json
{
  "id": "run-uuid",
  "status": "pending",
  "prompt": "your task description",
  "model": "claude-sonnet-4-20250514",
  "started_at": "2024-01-01T00:00:00Z",
  "artifact_count": 0,
  "options": {
    "timeout": 300,
    "max_tokens": 4096
  }
}
```

#### GET `/api/runs`
Retrieve all runs, optionally filtered.

**Authentication:** Required

**Query Parameters:**
- `status` - Filter by status (pending|running|completed|failed|cancelled)
- `client_id` - Filter by client ID
- `limit` - Maximum number of results (default: 50)
- `offset` - Pagination offset (default: 0)
- `sort_by` - Sort field (created_at|updated_at|status)
- `sort_order` - Sort direction (asc|desc, default: desc)

**Response (200 OK):**
```json
{
  "runs": [
    {
      "id": "run-uuid",
      "status": "completed",
      "prompt": "task description",
      "model": "claude-sonnet-4-20250514",
      "started_at": "2024-01-01T00:00:00Z",
      "completed_at": "2024-01-01T00:01:00Z",
      "artifact_count": 2,
      "client_id": "client-uuid"
    }
  ],
  "total": 1
}
```

#### GET `/api/runs/:id`
Retrieve a specific run by ID.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "run-uuid",
  "status": "completed",
  "prompt": "task description",
  "result": "output from execution",
  "error": null,
  "model": "claude-sonnet-4-20250514",
  "started_at": "2024-01-01T00:00:00Z",
  "completed_at": "2024-01-01T00:01:00Z",
  "artifact_count": 2,
  "client_id": "client-uuid",
  "options": {
    "timeout": 300,
    "max_tokens": 4096
  }
}
```

**Response (404 Not Found):**
```json
{
  "error": "Run not found"
}
```

#### PATCH `/api/runs/:id`
Update a run's status or metadata.

**Authentication:** Required

**Request Body:**
```json
{
  "status": "running",
  "result": "partial output..."
}
```

**Response (200 OK):**
```json
{
  "id": "run-uuid",
  "status": "running",
  "result": "partial output...",
  "updated_at": "2024-01-01T00:00:30Z"
}
```

#### DELETE `/api/runs/:id`
Cancel a running or pending run.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "run-uuid",
  "status": "cancelled"
}
```

**Response (400 Bad Request):**
```json
{
  "error": "Cannot cancel completed run"
}
```

#### POST `/api/runs/:id/retry`
Retry a failed run with the same parameters.

**Authentication:** Required

**Response (201 Created):**
```json
{
  "id": "new-run-uuid",
  "status": "pending",
  "prompt": "original task description",
  "model": "claude-sonnet-4-20250514",
  "retry_of": "original-run-uuid",
  "started_at": "2024-01-01T00:05:00Z"
}
```

---

### Artifact Routes

#### GET `/api/runs/:id/artifacts`
Retrieve all artifacts for a specific run.

**Authentication:** Required

**Query Parameters:**
- `limit` - Maximum number of results (default: 100)
- `offset` - Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "artifacts": [
    {
      "id": "artifact-uuid",
      "run_id": "run-uuid",
      "filename": "output.txt",
      "size": 1234,
      "content_type": "text/plain",
      "created_at": "2024-01-01T00:00:30Z"
    }
  ],
  "total": 1
}
```

#### POST `/api/runs/:id/artifacts`
Upload an artifact for a specific run.

**Authentication:** Required

**Request:** `multipart/form-data`
- `file` - The file to upload
- `metadata` - Optional JSON string with additional metadata

**Response (201 Created):**
```json
{
  "id": "artifact-uuid",
  "run_id": "run-uuid",
  "filename": "uploaded.txt",
  "size": 1234,
  "content_type": "text/plain",
  "created_at": "2024-01-01T00:00:30Z",
  "metadata": {}
}
```

#### GET `/api/artifacts/:id`
Download a specific artifact by ID.

**Authentication:** Required

**Response:** File content with appropriate `Content-Type` header

**Response (404 Not Found):**
```json
{
  "error": "Artifact not found"
}
```

#### GET `/api/artifacts/:id/info`
Get artifact metadata without downloading.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "artifact-uuid",
  "run_id": "run-uuid",
  "filename": "output.txt",
  "size": 1234,
  "content_type": "text/plain",
  "created_at": "2024-01-01T00:00:30Z",
  "path": ".data/artifacts/run-id/artifact-id_filename.txt"
}
```

#### DELETE `/api/artifacts/:id`
Delete a specific artifact.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "message": "Artifact deleted"
}
```

#### GET `/api/artifacts`
List all artifacts across all runs.

**Authentication:** Required

**Query Parameters:**
- `run_id` - Filter by run ID
- `content_type` - Filter by content type
- `limit` - Maximum number of results (default: 100)
- `offset` - Pagination offset (default: 0)

**Response (200 OK):**
```json
{
  "artifacts": [
    {
      "id": "artifact-uuid",
      "run_id": "run-uuid",
      "filename": "output.txt",
      "size": 1234,
      "content_type": "text/plain",
      "created_at": "2024-01-01T00:00:30Z"
    }
  ],
  "total": 1
}
```

---

### Model Routes

#### GET `/api/models`
Retrieve available models.

**Authentication:** Required

**Query Parameters:**
- `provider` - Filter by provider (anthropic|openai|custom)

**Response (200 OK):**
```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "Claude Sonnet 4",
      "provider": "anthropic",
      "context_length": 200000,
      "max_tokens": 8192,
      "supports_vision": false,
      "supports_tools": true
    },
    {
      "id": "claude-opus-4-20250514",
      "name": "Claude Opus 4",
      "provider": "anthropic",
      "context_length": 200000,
      "max_tokens": 4096,
      "supports_vision": false,
      "supports_tools": true
    }
  ],
  "total": 2
}
```

#### GET `/api/models/:id`
Retrieve details for a specific model.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "provider": "anthropic",
  "description": "Balanced model for most tasks",
  "context_length": 200000,
  "max_tokens": 8192,
  "input_cost": 3.0,
  "output_cost": 15.0,
  "supports_vision": false,
  "supports_tools": true,
  "available": true
}
```

**Response (404 Not Found):**
```json
{
  "error": "Model not found"
}
```

---

### Alert Routes

#### GET `/api/alerts`
Retrieve all alerts, optionally filtered.

**Authentication:** Required

**Query Parameters:**
- `type` - Filter by type (error|warning|info)
- `unread` - Only return unread alerts (true|false)
- `run_id` - Filter by run ID
- `client_id` - Filter by client ID
- `limit` - Maximum number of results (default: 100)
- `offset` - Pagination offset (default: 0)
- `sort_by` - Sort field (created_at|type)
- `sort_order` - Sort direction (asc|desc, default: desc)

**Response (200 OK):**
```json
{
  "alerts": [
    {
      "id": "alert-uuid",
      "type": "error",
      "message": "Execution failed",
      "run_id": "run-uuid",
      "client_id": "client-uuid",
      "created_at": "2024-01-01T00:00:00Z",
      "read": false,
      "metadata": {}
    }
  ],
  "total": 1,
  "unread_count": 1
}
```

#### GET `/api/alerts/:id`
Retrieve a specific alert by ID.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "alert-uuid",
  "type": "error",
  "message": "Execution failed",
  "run_id": "run-uuid",
  "client_id": "client-uuid",
  "created_at": "2024-01-01T00:00:00Z",
  "read": false,
  "metadata": {}
}
```

#### POST `/api/alerts/:id/read`
Mark an alert as read.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "id": "alert-uuid",
  "read": true
}
```

#### POST `/api/alerts/mark-all-read`
Mark all alerts as read for the authenticated client.

**Authentication:** Required

**Query Parameters:**
- `run_id` - Optional: only mark alerts for a specific run

**Response (200 OK):**
```json
{
  "marked_count": 5
}
```

#### DELETE `/api/alerts/:id`
Delete an alert.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "message": "Alert deleted"
}
```

#### DELETE `/api/alerts/clear`
Clear all alerts, optionally filtered.

**Authentication:** Required

**Query Parameters:**
- `type` - Optional: only clear alerts of this type
- `read` - Optional: only clear read (true) or unread (false) alerts
- `run_id` - Optional: only clear alerts for a specific run

**Response (200 OK):**
```json
{
  "deleted_count": 10
}
```

---

### Dashboard Routes

#### GET `/api/dashboard/stats`
Retrieve dashboard statistics.

**Authentication:** Required

**Query Parameters:**
- `client_id` - Optional: filter stats for a specific client

**Response (200 OK):**
```json
{
  "total_runs": 100,
  "active_runs": 3,
  "completed_runs": 95,
  "failed_runs": 2,
  "cancelled_runs": 0,
  "total_artifacts": 250,
  "total_clients": 5,
  "unread_alerts": 1,
  "total_tokens_used": 500000,
  "avg_execution_time": 45.5
}
```

#### GET `/api/dashboard/recent`
Retrieve recent activity.

**Authentication:** Required

**Query Parameters:**
- `limit` - Maximum number of items (default: 10)
- `type` - Filter by activity type (runs|alerts|all, default: all)

**Response (200 OK):**
```json
{
  "runs": [
    {
      "id": "run-uuid",
      "status": "completed",
      "prompt": "task description",
      "started_at": "2024-01-01T00:00:00Z",
      "completed_at": "2024-01-01T00:01:00Z"
    }
  ],
  "alerts": [
    {
      "id": "alert-uuid",
      "type": "error",
      "message": "Error message",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

#### GET `/api/dashboard/metrics`
Retrieve aggregated metrics for charts and analytics.

**Authentication:** Required

**Query Parameters:**
- `period` - Time period (hour|day|week|month, default: day)
- `start_date` - Start date (ISO 8601)
- `end_date` - End date (ISO 8601)

**Response (200 OK):**
```json
{
  "period": "day",
  "start_date": "2024-01-01T00:00:00Z",
  "end_date": "2024-01-02T00:00:00Z",
  "runs_by_status": {
    "completed": 45,
    "failed": 2,
    "running": 1
  },
  "runs_over_time": [
    {
      "timestamp": "2024-01-01T00:00:00Z",
      "count": 10
    }
  ],
  "tokens_used": 50000,
  "avg_execution_time": 42.3
}
```

---

### Health Routes

#### GET `/health`
Health check endpoint.

**Authentication:** Not required

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "database": "connected",
  "version": "1.1.0"
}
```

#### GET `/health/ready`
Readiness probe for container orchestration.

**Authentication:** Not required

**Response (200 OK):**
```json
{
  "ready": true,
  "checks": {
    "database": "ok",
    "storage": "ok",
    "external_services": "ok"
  }
}
```

#### GET `/health/live`
Liveness probe for container orchestration.

**Authentication:** Not required

**Response (200 OK):**
```json
{
  "alive": true,
  "uptime": 3600
}
```

---

### System Routes

#### GET `/api/system/info`
Retrieve system information.

**Authentication:** Required

**Response (200 OK):**
```json
{
  "version": "1.1.0",
  "environment": "production",
  "node_version": "v20.0.0",
  "uptime": 86400,
  "memory": {
    "used": 256,
    "total": 512,
    "unit": "MB"
  },
  "cpu": {
    "usage": 25.5,
    "cores": 4
  }
}
```

#### POST `/api/system/cleanup`
Trigger system cleanup tasks.

**Authentication:** Required

**Request Body:**
```json
{
  "older_than_days": 30,
  "dry_run": false
}
```

**Response (200 OK):**
```json
{
  "deleted_runs": 5,
  "deleted_artifacts": 15,
  "deleted_alerts": 20,
  "space_freed": "25MB"
}
```

---

### Metrics Routes

#### GET `/metrics`
Prometheus-compatible metrics endpoint.

**Authentication:** Not required (configure via environment)

**Response:** Plain text metrics in Prometheus format

---

### WebSocket Routes

#### WS `/ws`
WebSocket endpoint for real-time updates.

**Authentication:** Required (send auth message first)

**Connection:** `ws://localhost:3000/ws` (or `wss://` for TLS)

---

## Error Responses

All endpoints may return standard error responses:

### 400 Bad Request
```json
{
  "error": "Invalid request parameters"
}
```

### 401 Unauthorized
```json
{
  "error": "Invalid or missing API key"
}
```

### 404 Not Found
```json
{
  "error": "Resource not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Internal server error"
}
```

---

## WebSocket Connection

### Connection URL
`ws://localhost:3000/ws` (or `wss://` for TLS)

### Authentication
Send API key as first message:
```json
{
  "type": "auth",
  "api_key": "sk-..."
}
```

### Events

#### Run Status Update
```json
{
  "type": "run_update",
  "run_id": "run-uuid",
  "status": "running"
}
```

#### Run Completed
```json
{
  "type": "run_complete",
  "run_id": "run-uuid",
  "status": "completed",
  "result": "output..."
}
```

#### New Alert
```json
{
  "type": "alert",
  "alert": {
    "id": "alert-uuid",
    "type": "error",
    "message": "Error message",
    "run_id": "run-uuid"
  }
}
```

---

## Rate Limiting

- Default: 100 requests per minute per API key
- Burst: 20 requests per second
- Rate limit headers included in responses:
  - `X-RateLimit-Limit`
  - `X-RateLimit-Remaining`
  - `X-RateLimit-Reset`

---

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Gateway server port | 3000 |
| `HOST` | Gateway server host | 0.0.0.0 |
| `NODE_ENV` | Environment | development |
| `DATABASE_PATH` | Path to SQLite database | .data/db.sqlite |
| `TLS_CERT` | Path to TLS certificate | .data/certs/server.crt |
| `TLS_KEY` | Path to TLS private key | .data/certs/server.key |
| `ANTHROPIC_API_KEY` | Anthropic API key | Required |

---

## Deployment

### Development
```bash
npm run dev:gateway
```

### Production
```bash
npm run build
npm run start
```

### Using PM2
```bash
pm2 start npm --name "ai-remote-gateway" -- start
pm2 save
pm2 startup
```

---

## Monitoring

### Health Check
`GET /health`

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2024-01-01T00:00:00Z",
  "database": "connected"
}
```

### Metrics Endpoint
`GET /metrics`

Returns Prometheus-compatible metrics for monitoring.

---

## Backup & Recovery

### Database Backup
```bash
cp .data/db.sqlite .data/db.sqlite.backup.$(date +%Y%m%d)
```

### Restore
```bash
cp .data/db.sqlite.backup.20240101 .data/db.sqlite
```

### Artifact Backup
```bash
tar -czf artifacts-backup-$(date +%Y%m%d).tar.gz .data/artifacts/
```

---

## Troubleshooting

### Common Issues

#### Database Locked
- Ensure only one gateway instance is running
- Check for hanging transactions

#### Connection Refused
- Verify the gateway is running: `pm2 status`
- Check firewall settings

#### Artifact Upload Fails
- Verify disk space: `df -h .data/`
- Check file size limits in configuration

#### WebSocket Disconnections
- Check network stability
- Verify TLS certificates are valid
- Review server logs for errors

---

## Security Considerations

1. **API Keys**: Treat as secrets, rotate regularly
2. **TLS**: Always use HTTPS in production
3. **Database**: Restrict file permissions on `.data/db.sqlite`
4. **Artifacts**: Scan uploaded files for malware
5. **Rate Limiting**: Adjust based on usage patterns
6. **Authentication**: Use strong client names and rotate API keys

For more security details, see [SECURITY.md](SECURITY.md).