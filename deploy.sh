#!/bin/bash
# Zero-downtime deploy: nginx stays up while api restarts
# React frontend is embedded in the api image, no separate ui service.
# Usage: ./deploy.sh
set -e

cd "$(dirname "$0")"

echo "==> Building image (containers still serving) …"
docker compose build

echo "==> Restarting api …"
docker compose up -d --no-deps api
echo "    Waiting for api to be healthy …"
for i in $(seq 1 30); do
    if docker inspect --format='{{.State.Health.Status}}' uc02-group-assistant-api-1 2>/dev/null | grep -q healthy; then
        echo "    api healthy ✓"
        break
    fi
    sleep 2
done

echo "==> Reloading nginx config (zero downtime) …"
docker compose exec nginx nginx -s reload

echo ""
docker compose ps
echo ""
echo "Deploy complete. Dashboard: http://$(curl -s ifconfig.me 2>/dev/null || echo '<VM_IP>'):8888"
