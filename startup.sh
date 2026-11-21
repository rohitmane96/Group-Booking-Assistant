#!/usr/bin/env bash
# startup.sh — bootstrap + run all services locally (non-Docker)
# Usage: ./startup.sh

set -e
cd "$(dirname "$0")"

echo "=== UC02 Group Booking Assistant ==="

# activate venv if present
if [ -d ".venv" ]; then
  source .venv/bin/activate
fi

# load .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

echo "[1/4] Installing dependencies …"
pip install -q -r requirements.txt

echo "[2/4] Building database and feature cache …"
python -m etl.build_snapshots

echo "[3/4] Training conversion model …"
python -m models.train_conversion

echo "[4/4] Starting API and UI …"
# Start API in background
python -m uvicorn api.main:app --host 0.0.0.0 --port 8000 &
API_PID=$!
echo "  API running at http://localhost:8000 (PID $API_PID)"

# Give API a moment to start
sleep 3

# Start Streamlit
streamlit run ui/app.py --server.port 8501 --server.address 0.0.0.0 \
  --server.headless true --browser.gatherUsageStats false &
UI_PID=$!
echo "  UI  running at http://localhost:8501 (PID $UI_PID)"

echo ""
echo "=== All services started ==="
echo "  Dashboard: http://localhost:8501"
echo "  API docs:  http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop."
wait
