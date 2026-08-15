# AWS EC2 Deployment (Ubuntu)

Portable deployment using Docker Compose — no AWS-specific code in business logic.

## 1. Create EC2 instance

- **AMI:** Ubuntu 24.04 LTS
- **Type:** `t3.small` minimum (backtests are CPU-bound)
- **Storage:** 30 GB gp3
- **Key pair:** SSH access

## 2. Security group

| Port | Source | Purpose |
|------|--------|---------|
| 22 | Your IP only | SSH |
| 80 | 0.0.0.0/0 | HTTP (Nginx → redirect HTTPS) |
| 443 | 0.0.0.0/0 | HTTPS |

> **Do not expose** PostgreSQL (5432) or Redis (6379) to the internet. Use Docker internal networking only.

## 3. Install Docker

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
sudo apt install -y docker-compose-plugin
```

## 4. Clone and configure

```bash
git clone <your-repo-url> regimex && cd regimex
cp .env.example .env
nano .env
```

Production `.env` changes:

```env
NODE_ENV=production
DATABASE_URL=postgresql://regimex:STRONG_PASSWORD@postgres:5432/regimex
CORS_ORIGINS=https://your-domain.com
DEMO_TRADING_ENABLED=false
SEED_ON_START=false
LOG_LEVEL=info
```

Generate strong secrets:

```bash
openssl rand -hex 32  # repeat for JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, CREDENTIAL_ENCRYPTION_KEY
```

## 5. Start services

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:4000/health/ready
```

## 6. Nginx reverse proxy

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/regimex`:

```nginx
server {
    listen 80;
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/regimex /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com
```

## 7. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

## 8. Restart policies

Docker Compose `restart: unless-stopped` handles process restarts. For bare-metal without Docker, use PM2:

```bash
pm2 start "pnpm --filter @regimex/api start" --name regimex-api
pm2 start "pnpm --filter @regimex/worker start" --name regimex-worker
pm2 save && pm2 startup
```

## 9. Log rotation

```bash
# Docker logs
sudo nano /etc/docker/daemon.json
# { "log-driver": "json-file", "log-options": { "max-size": "50m", "max-file": "5" } }
sudo systemctl restart docker
```

## 10. Backups

- **PostgreSQL:** daily `pg_dump` to S3 (cron + `aws s3 cp`)
- **Redis:** ephemeral — no backup needed for job queues
- Test restore monthly

## 11. AWS budget alerts

AWS Console → Billing → Budgets → create monthly budget with email alert at 80% and 100%.

## 12. Verify health

```bash
curl https://api.yourdomain.com/health
curl https://api.yourdomain.com/health/ready
curl https://api.yourdomain.com/health/live
```

## Managed database option

For production, replace Docker Postgres with RDS:

- Update `DATABASE_URL` to RDS endpoint
- Remove `postgres` service from `docker-compose.yml`
- Ensure security group allows EC2 → RDS on 5432 only

Same pattern for ElastiCache Redis.

## Risks

- Exposing DB/Redis publicly = credential theft
- Running without HTTPS = token interception
- Enabling `DEMO_TRADING_ENABLED` without understanding risk limits
- Treating backtest profit as guaranteed
