# Local Development Environment

Complete Docker Compose setup for running the entire Pipeline Builder platform locally.

## Overview

This local development environment provides a fully functional instance of Pipeline Builder with all supporting services, databases, and infrastructure components running in Docker containers.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     NGINX Reverse Proxy                      │
│              (https://localhost:8443)                        │
│           SSL/TLS, JWT Auth, Load Balancing                  │
└────┬──────────┬──────────┬──────────┬──────────┬────────────┘
     │          │          │          │          │
     ▼          ▼          ▼          ▼          ▼
┌─────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌───────┐
│Frontend │ │Platform│ │ Plugin │ │Pipeline│ │ Quota │
│ (React) │ │ Service│ │Service │ │Service │ │Service│
└────┬────┘ └───┬────┘ └───┬────┘ └───┬────┘ └───┬───┘
     │          │          │          │          │
     └──────────┴──────────┴──────────┘          │
                │                                 │
           ┌────▼─────┐                      ┌────▼─────┐
           │PostgreSQL│                      │ MongoDB  │
           │  :5432   │                      │  :27017  │
           └──────────┘                      └──────────┘
```

## Prerequisites

- **Docker** >= 20.10.0
- **Docker Compose** >= 2.0.0
- **Node.js** >= 24.9.0 (for building services locally)
- **pnpm** >= 9.0.0 (for dependency management)

## Quick Start

### 1. Initial Setup

```bash
# Navigate to the local deployment directory
cd deploy/local

# Make scripts executable (first time only)
chmod +x bin/startup.sh bin/shutdown.sh

# Create required directories
mkdir -p db-data/mongodb db-data/postgres registry-data pgadmin-data
```

### 2. Configure Environment

Edit the `.env` file to configure your local environment. Key variables include:

```bash
# URLs
PLATFORM_BASE_URL=https://localhost:8443
PLATFORM_FRONTEND_URL=https://localhost:8443

# Secrets (generate secure values for production)
JWT_SECRET=your-jwt-secret-here
REFRESH_TOKEN_SECRET=your-refresh-token-secret-here

# Database Configuration
DB_HOST=postgres
DB_PORT=5432
DATABASE=pipelinebuilder
DB_USER=postgres
DB_PASSWORD=your-secure-password

# MongoDB Configuration
MONGO_HOST=mongodb
MONGO_PORT=27017
MONGO_DATABASE=quotas
MONGO_USERNAME=admin
MONGO_PASSWORD=your-secure-password
```

### 3. Start Services

```bash
# Start all services
./bin/startup.sh

# Or manually with docker compose
docker compose up --build --remove-orphans
```

Wait for all services to start (approximately 60-90 seconds). Monitor logs for health check confirmations.

### 4. Verify Deployment

```bash
# Check all services are running
docker compose ps

# View logs from all services
docker compose logs -f

# View logs from a specific service
docker compose logs -f frontend
docker compose logs -f platform
```

## Services Overview

### Core Services

| Service | Description | Port | Health Endpoint |
|---------|-------------|------|-----------------|
| **nginx** | Reverse proxy with SSL/TLS termination | 8443 (HTTPS), 8080 (HTTP) | - |
| **frontend** | Next.js React application | 3000 (internal) | `/health` |
| **platform** | Authentication & organization service | 3000 (internal) | `/health` |
| **plugin** | Plugin definition CRUD API | 3000 (internal) | `/health` |
| **pipeline** | Pipeline configuration CRUD API | 3000 (internal) | `/health` |
| **quota** | Rate limiting & usage tracking | 3000 (internal) | `/health` |

### Database Services

| Service | Description | Port | Access |
|---------|-------------|------|--------|
| **postgres** | PostgreSQL database | 5432 | `postgres://postgres:password@localhost:5432/pipelinebuilder` |
| **mongodb** | MongoDB for quota tracking | 27017 | `mongodb://admin:password@localhost:27017` |

### Management & Utility Services

| Service | Description | Port | URL |
|---------|-------------|------|-----|
| **pgadmin** | PostgreSQL admin interface | 5050 | http://localhost:5050 |
| **mongo-express** | MongoDB admin interface | 8081 | http://localhost:8081 |
| **registry** | Docker image registry | 5000 | http://localhost:5000 |
| **registry-express** | Docker registry UI | 8082 | http://localhost:8082 |

## Accessing Services

### Web Interfaces

- **Frontend Application**: https://localhost:8443
- **Platform API**: https://localhost:8443/api/platform
- **Plugin API**: https://localhost:8443/api/plugins
- **Pipeline API**: https://localhost:8443/api/pipelines
- **Quota API**: https://localhost:8443/api/quota

### Admin Panels

- **pgAdmin** (PostgreSQL): http://localhost:5050
  - Email: `admin@pipelinebuilder.local`
  - Password: See `.env` file (`PGADMIN_DEFAULT_PASSWORD`)

- **Mongo Express** (MongoDB): http://localhost:8081
  - Username: See `.env` file (`ME_CONFIG_BASICAUTH_USERNAME`)
  - Password: See `.env` file (`ME_CONFIG_BASICAUTH_PASSWORD`)

- **Registry UI** (Docker Registry): http://localhost:8082

### API Authentication

All API endpoints require JWT authentication (except public endpoints). To authenticate:

1. **Register/Login** via the frontend at https://localhost:8443
2. **Obtain JWT token** from the login response
3. **Include in requests**:
   ```bash
   curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
        https://localhost:8443/api/pipelines
   ```

## Common Commands

### Service Management

```bash
# Start all services
./bin/startup.sh

# Stop all services
./bin/shutdown.sh

# Restart a specific service
docker compose restart platform

# Rebuild and restart a service
docker compose up -d --build platform

# View service logs
docker compose logs -f platform plugin pipeline

# Check service status
docker compose ps
```

### Database Management

```bash
# Connect to PostgreSQL
docker compose exec postgres psql -U postgres -d pipelinebuilder

# Connect to MongoDB
docker compose exec mongodb mongosh -u admin -p your-password --authenticationDatabase admin

# Backup PostgreSQL database
docker compose exec postgres pg_dump -U postgres pipelinebuilder > backup.sql

# Restore PostgreSQL database
docker compose exec -T postgres psql -U postgres pipelinebuilder < backup.sql

# Run Drizzle migrations (from project root)
cd ../../packages/pipeline-data
pnpm drizzle-kit push
```

### Container Management

```bash
# Remove all containers and volumes (⚠️ DATA LOSS)
docker compose down -v

# Remove containers but keep volumes
docker compose down

# Clean up dangling images
docker image prune

# View resource usage
docker stats
```

## Directory Structure

```
deploy/local/
├── bin/
│   ├── startup.sh              # Start all services
│   └── shutdown.sh             # Stop all services
├── certs/
│   ├── nginx.crt               # SSL certificate
│   └── nginx.key               # SSL private key
├── nginx/
│   ├── nginx.conf              # NGINX configuration
│   ├── jwt.js                  # JWT validation module
│   └── metrics.js              # Metrics collection module
├── db-data/                    # Database persistent storage (gitignored)
│   ├── mongodb/                # MongoDB data files
│   └── postgres/               # PostgreSQL data files
├── pgadmin-data/               # pgAdmin config storage (gitignored)
├── registry-data/              # Docker registry storage (gitignored)
├── plugins/                    # Plugin definitions
├── .env                        # Environment configuration
├── docker-compose.yml          # Service orchestration
├── postgres-init.sql           # PostgreSQL initialization script
├── mongodb-init.js             # MongoDB initialization script
└── README.md                   # This file
```

## Environment Variables

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `JWT_SECRET` | Secret for JWT token signing | `your-256-bit-secret` |
| `REFRESH_TOKEN_SECRET` | Secret for refresh tokens | `another-256-bit-secret` |
| `DB_PASSWORD` | PostgreSQL password | `secure-db-password` |
| `MONGO_PASSWORD` | MongoDB admin password | `secure-mongo-password` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOG_LEVEL` | Logging verbosity | `info` |
| `LIMITER_MAX` | Rate limit max requests | `100` |
| `LIMITER_WINDOWMS` | Rate limit window (ms) | `900000` (15 min) |
| `DRIZZLE_MAX_POOL_SIZE` | PostgreSQL connection pool size | `20` |

### Service URLs

| Variable | Description | Default |
|----------|-------------|---------|
| `PLATFORM_BASE_URL` | Platform service base URL | `https://localhost:8443` |
| `PLATFORM_FRONTEND_URL` | Frontend application URL | `https://localhost:8443` |
| `CORS_ORIGIN` | CORS allowed origins | `https://localhost:8443` |

## Troubleshooting

### Services Won't Start

**Symptom**: Docker compose fails to start services

```bash
# Check for port conflicts
lsof -i :8443
lsof -i :5432
lsof -i :27017

# Check Docker daemon
docker info

# View detailed logs
docker compose logs
```

### Health Checks Failing

**Symptom**: Services show as unhealthy

```bash
# Check service logs
docker compose logs platform plugin pipeline quota

# Verify database connectivity
docker compose exec platform ping -c 3 postgres
docker compose exec quota ping -c 3 mongodb

# Check environment variables
docker compose exec platform env | grep DB_
```

### Database Connection Issues

**Symptom**: Services can't connect to databases

```bash
# Verify PostgreSQL is accepting connections
docker compose exec postgres pg_isready -U postgres

# Verify MongoDB is accepting connections
docker compose exec mongodb mongosh --eval "db.adminCommand('ping')" -u admin -p your-password

# Check database credentials in .env file
cat .env | grep -E "(DB_|MONGO_)"
```

### SSL/TLS Certificate Issues

**Symptom**: Browser shows certificate warnings

**Solution**: The local development certificates are self-signed. You can:
1. Accept the browser security warning (recommended for local dev)
2. Add the certificate to your system's trusted certificates
3. Generate new certificates:
   ```bash
   cd certs
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -keyout nginx.key -out nginx.crt
   ```

### Permission Issues

**Symptom**: Cannot write to mounted volumes

```bash
# Fix ownership of data directories
sudo chown -R $(whoami):$(id -gn) db-data pgadmin-data registry-data

# Ensure scripts are executable
chmod +x bin/startup.sh bin/shutdown.sh
```

### Out of Memory Errors

**Symptom**: Services crash with OOM errors

**Solution**: Increase Docker Desktop memory allocation:
1. Open Docker Desktop Settings
2. Go to Resources → Advanced
3. Increase memory to at least 8GB
4. Restart Docker Desktop

### Reset Everything

**⚠️ WARNING: This deletes all data**

```bash
# Stop services
./bin/shutdown.sh

# Remove volumes (deletes all data)
docker compose down -v

# Remove data directories
rm -rf db-data pgadmin-data registry-data

# Rebuild from scratch
./bin/startup.sh
```

## Development Workflow

### Making Code Changes

1. **Build locally**:
   ```bash
   # From project root
   pnpm install
   pnpm build
   ```

2. **Rebuild specific service**:
   ```bash
   # From deploy/local
   docker compose up -d --build platform
   ```

3. **View updated logs**:
   ```bash
   docker compose logs -f platform
   ```

### Testing API Changes

```bash
# Test platform service health
curl -k https://localhost:8443/api/platform/health

# Test authenticated endpoint
curl -k -H "Authorization: Bearer YOUR_TOKEN" \
  https://localhost:8443/api/pipelines
```

### Database Schema Changes

```bash
# Update Drizzle schema files in packages/pipeline-data/src/

# Push schema changes to database
cd packages/pipeline-data
pnpm drizzle-kit push

# Generate migrations (optional)
pnpm drizzle-kit generate
```

## Resource Limits

Default resource limits per service (defined in docker-compose.yml):

- **API Services**: 768MB RAM, 0.75 CPU
- **NGINX**: 256MB RAM, 0.5 CPU
- **PostgreSQL**: 512MB RAM, 1 CPU
- **MongoDB**: 512MB RAM, 1 CPU
- **Frontend**: 512MB RAM, 0.5 CPU

Total estimated memory usage: ~6-8GB

## Security Notes

### For Local Development Only

⚠️ **This configuration is for local development only**. Do not use in production:

- Self-signed SSL certificates
- Default passwords in `.env` file
- Disabled security features for ease of development
- Admin panels exposed without authentication
- Permissive CORS settings

### Production Deployment

For production deployments:
- Use proper SSL certificates from a CA
- Rotate all secrets and use strong passwords
- Enable all security features (CSP, HSTS, etc.)
- Restrict CORS origins
- Use secrets management (AWS Secrets Manager, Vault, etc.)
- Enable network policies and firewalls
- Set up monitoring and alerting

## Support

For issues with the local development environment:

1. Check the [Troubleshooting](#troubleshooting) section above
2. Review service logs: `docker compose logs`
3. Open an issue at: https://github.com/mwashburn160/pipeline-builder/issues

---

**Local Development Environment v1.0.0**
