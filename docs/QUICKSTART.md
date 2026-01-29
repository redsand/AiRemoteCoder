# Quickstart Guide

## Prerequisites

- Node.js 20+
- Claude Code CLI installed and authenticated
- (Optional) Cloudflare account for secure remote access

## Local Development Setup

### 1. Start the Gateway

```bash
# Linux/macOS
./run.sh

# Windows
.\run.ps1
```

This will:
- Check Node.js version (requires 20+)
- Install dependencies (`npm install`)
- Build the gateway, wrapper, and UI
- Generate secure secrets in `.env` (first run only)
- Generate self-signed TLS certificates
- Start the gateway on `https://localhost:8443`

### 2. Access the UI

Open your browser to:
```
https://localhost:8443
```

Note: You may see a certificate warning since we use self-signed certificates for development. This is expected and safe for local development.

## API Endpoints

The gateway provides RESTful API endpoints organized by feature:

### Authentication Endpoints

#### POST `/api/auth/register`
Register a new user account.

**Request Body:**
```json
{
  "username": "string",
  "email": "string",
  "password": "string"
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "username": "string",
    "email": "string",
    "createdAt": "string"
  }
}
```

#### POST `/api/auth/login`
Authenticate and receive a session token.

**Request Body:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "string",
    "user": {
      "id": "string",
      "username": "string",
      "email": "string"
    }
  }
}
```

#### POST `/api/auth/logout`
Invalidate the current session.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Logged out successfully"
}
```

#### POST `/api/auth/refresh`
Refresh an expired authentication token.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "token": "string"
  }
}
```

### Client Management Endpoints

#### GET `/api/clients`
List all registered clients.

**Headers:**
```
Authorization: Bearer <token>
```

**Query Parameters:**
- `page` (optional): Page number for pagination
- `limit` (optional): Items per page

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "name": "string",
      "status": "connected|disconnected",
      "lastSeen": "string",
      "ipAddress": "string"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 100
  }
}
```

#### POST `/api/clients`
Register a new client.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "name": "string",
  "description": "string",
  "capabilities": ["string"]
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "apiKey": "string",
    "secret": "string",
    "status": "connected",
    "createdAt": "string"
  }
}
```

#### GET `/api/clients/:id`
Get details for a specific client.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "description": "string",
    "status": "connected|disconnected",
    "capabilities": ["string"],
    "lastSeen": "string",
    "ipAddress": "string",
    "createdAt": "string",
    "updatedAt": "string"
  }
}
```

#### PUT `/api/clients/:id`
Update client information.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "name": "string",
  "description": "string",
  "capabilities": ["string"]
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "description": "string",
    "status": "connected",
    "capabilities": ["string"],
    "updatedAt": "string"
  }
}
```

#### DELETE `/api/clients/:id`
Unregister a client.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Client deleted successfully"
}
```

### Alert Management Endpoints

#### GET `/api/alerts`
List all alert rules.

**Headers:**
```
Authorization: Bearer <token>
```

**Query Parameters:**
- `active` (optional): Filter by active status (`true`|`false`)
- `severity` (optional): Filter by severity level (`low`|`medium`|`high`|`critical`)
- `page` (optional): Page number for pagination
- `limit` (optional): Items per page

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "name": "string",
      "description": "string",
      "severity": "low|medium|high|critical",
      "enabled": true,
      "conditions": {
        "metric": "string",
        "operator": "gt|lt|eq|gte|lte",
        "threshold": "number",
        "duration": "number"
      },
      "actions": ["string"],
      "createdAt": "string"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 10
  }
}
```

#### POST `/api/alerts`
Create a new alert rule.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "name": "string",
  "description": "string",
  "severity": "low|medium|high|critical",
  "enabled": true,
  "conditions": {
    "metric": "string",
    "operator": "gt|lt|eq|gte|lte",
    "threshold": "number",
    "duration": "number"
  },
  "actions": ["email", "webhook", "log"]
}
```

**Response (201):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "description": "string",
    "severity": "high",
    "enabled": true,
    "conditions": {
      "metric": "string",
      "operator": "gt",
      "threshold": 90,
      "duration": 300
    },
    "actions": ["email", "webhook", "log"],
    "createdAt": "string"
  }
}
```

#### GET `/api/alerts/:id`
Get details for a specific alert rule.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "description": "string",
    "severity": "high",
    "enabled": true,
    "conditions": {
      "metric": "string",
      "operator": "gt",
      "threshold": 90,
      "duration": 300
    },
    "actions": ["email", "webhook", "log"],
    "triggeredCount": 5,
    "lastTriggered": "string",
    "createdAt": "string",
    "updatedAt": "string"
  }
}
```

#### PUT `/api/alerts/:id`
Update an alert rule.

**Headers:**
```
Authorization: Bearer <token>
```

**Request Body:**
```json
{
  "name": "string",
  "description": "string",
  "severity": "high",
  "enabled": true,
  "conditions": {
    "metric": "string",
    "operator": "gt",
    "threshold": 95,
    "duration": 300
  },
  "actions": ["email", "webhook", "log"]
}
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "id": "string",
    "name": "string",
    "description": "string",
    "severity": "high",
    "enabled": true,
    "conditions": {
      "metric": "string",
      "operator": "gt",
      "threshold": 95,
      "duration": 300
    },
    "actions": ["email", "webhook", "log"],
    "updatedAt": "string"
  }
}
```

#### DELETE `/api/alerts/:id`
Delete an alert rule.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "message": "Alert rule deleted successfully"
}
```

#### GET `/api/alerts/history`
View alert trigger history.

**Headers:**
```
Authorization: Bearer <token>
```

**Query Parameters:**
- `ruleId` (optional): Filter by alert rule ID
- `startDate` (optional): Filter by start date (ISO 8601)
- `endDate` (optional): Filter by end date (ISO 8601)
- `page` (optional): Page number for pagination
- `limit` (optional): Items per page

**Response (200):**
```json
{
  "success": true,
  "data": [
    {
      "id": "string",
      "ruleId": "string",
      "ruleName": "string",
      "severity": "high",
      "triggeredAt": "string",
      "resolvedAt": "string",
      "value": "number",
      "message": "string"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 50
  }
}
```

### Health & Status Endpoints

#### GET `/api/health`
Check gateway health status.

**Response (200):**
```json
{
  "status": "healthy",
  "version": "1.1.0",
  "uptime": "string",
  "timestamp": "string"
}
```

#### GET `/api/status`
Get detailed system status.

**Headers:**
```
Authorization: Bearer <token>
```

**Response (200):**
```json
{
  "success": true,
  "data": {
    "gateway": {
      "status": "running",
      "version": "1.1.0",
      "uptime": "string"
    },
    "database": {
      "status": "connected",
      "latency": "number"
    },
    "clients": {
      "total": 10,
      "connected": 8,
      "disconnected": 2
    },
    "alerts": {
      "active": 5,
      "triggered24h": 12
    }
  }
}
```

## Authentication

All protected endpoints require a valid JWT bearer token in the `Authorization` header:

```bash
curl -H "Authorization: Bearer YOUR_TOKEN_HERE" https://localhost:8443/api/clients
```

### Token Lifecycle

1. **Login**: Receive a token via `/api/auth/login`
2. **Use**: Include the token in the `Authorization` header for all protected requests
3. **Refresh**: Use `/api/auth/refresh` before token expiration
4. **Logout**: Invalidate the token via `/api/auth/logout`

### Token Validation

The gateway validates tokens on each request using the authentication middleware:
- Checks token signature using configured secrets
- Verifies token expiration
- Validates user permissions

## Usage Examples

### Example 1: Complete Authentication Flow

```bash
# Register a new user
curl -X POST https://localhost:8443/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "admin",
    "email": "admin@example.com",
    "password": "securepassword123"
  }'

# Login
curl -X POST https://localhost:8443/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "securepassword123"
  }'

# Save the token from response
TOKEN="your_received_token_here"

# Use token for authenticated requests
curl -H "Authorization: Bearer $TOKEN" \
  https://localhost:8443/api/clients

# Refresh token when expired
curl -X POST https://localhost:8443/api/auth/refresh \
  -H "Authorization: Bearer $TOKEN"

# Logout
curl -X POST https://localhost:8443/api/auth/logout \
  -H "Authorization: Bearer $TOKEN"
```

### Example 2: Client Management

```bash
# Register a new client
curl -X POST https://localhost:8443/api/clients \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Server",
    "description": "Main production server",
    "capabilities": ["execute", "file_read", "file_write"]
  }'

# List all clients
curl -H "Authorization: Bearer $TOKEN" \
  https://localhost:8443/api/clients

# Get specific client
curl -H "Authorization: Bearer $TOKEN" \
  https://localhost:8443/api/clients/client-id-here

# Update client
curl -X PUT https://localhost:8443/api/clients/client-id-here \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Server (Updated)",
    "description": "Updated description"
  }'

# Delete client
curl -X DELETE https://localhost:8443/api/clients/client-id-here \
  -H "Authorization: Bearer $TOKEN"
```

### Example 3: Alert Management

```bash
# Create an alert rule
curl -X POST https://localhost:8443/api/alerts \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "High CPU Usage",
    "description": "Alert when CPU usage exceeds 90%",
    "severity": "high",
    "enabled": true,
    "conditions": {
      "metric": "cpu_usage",
      "operator": "gt",
      "threshold": 90,
      "duration": 300
    },
    "actions": ["email", "log"]
  }'

# List all active alerts
curl -H "Authorization: Bearer $TOKEN" \
  "https://localhost:8443/api/alerts?active=true"

# View alert history
curl -H "Authorization: Bearer $TOKEN" \
  "https://localhost:8443/api/alerts/history?page=1&limit=10"

# Update alert rule
curl -X PUT https://localhost:8443/api/alerts/alert-id-here \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "High CPU Usage (Updated)",
    "threshold": 95,
    "enabled": false
  }'

# Delete alert rule
curl -X DELETE https://localhost:8443/api/alerts/alert-id-here \
  -H "Authorization: Bearer $TOKEN"
```

### Example 4: Health Monitoring

```bash
# Check gateway health (no auth required)
curl https://localhost:8443/api/health

# Get detailed system status (auth required)
curl -H "Authorization: Bearer $TOKEN" \
  https://localhost:8443/api/status
```

## Error Responses

All endpoints may return error responses in the following format:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": {}
  }
}
```

### Common Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `UNAUTHORIZED` | 401 | Missing or invalid authentication token |
| `FORBIDDEN` | 403 | Insufficient permissions for the requested action |
| `NOT_FOUND` | 404 | Requested resource does not exist |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `CONFLICT` | 409 | Resource already exists or conflicts with existing data |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## Development Scripts

The following npm scripts are available for development:

```bash
# Start all services in development mode
npm run dev

# Start only the gateway
npm run dev:gateway

# Start only the UI
npm run dev:ui

# Build all packages
npm run build

# Start the production server
npm run start

# Run tests
npm run test

# Setup environment (first-time setup)
npm run setup
```

## Troubleshooting

### Port Already in Use

If you see an error about port 8443 being in use:

```bash
# Find and kill the process using the port
lsof -ti:8443 | xargs kill -9  # macOS/Linux
netstat -ano | findstr :8443   # Windows
```

### Certificate Warnings

Self-signed certificates will trigger browser warnings. For development:
- Chrome: Click "Advanced" → "Proceed to localhost"
- Firefox: Click "Advanced" → "Accept the Risk and Continue"

### Connection Refused

If you cannot connect to the gateway:
1. Verify the gateway is running: `curl https://localhost:8443/api/health`
2. Check the firewall settings
3. Ensure you're using HTTPS, not HTTP

### Token Expired

If you receive a 401 Unauthorized error:
1. Refresh your token using `/api/auth/refresh`
2. Or log in again to get a new token

## Next Steps

- Read the full [API Documentation](./API.md) for detailed endpoint specifications
- Check the [Security Guide](./SECURITY.md) for authentication and authorization details
- Review the [Architecture Overview](./ARCHITECTURE.md) to understand the system design
- Explore the [Configuration Guide](./CONFIGURATION.md) for customization options

## Support

For issues, questions, or contributions:
- GitHub Issues: [Project Repository]
- Documentation: [Full Docs Site]
- Community: [Discord/Slack Channel]