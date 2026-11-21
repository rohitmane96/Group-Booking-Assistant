# -- Stage 1: build the web UI (static export)
FROM node:22-slim AS frontend
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ .
RUN npm run build

# -- Stage 2: backend
FROM python:3.11-slim

# system deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# copy source
COPY . .

# built UI (served by FastAPI at /)
COPY --from=frontend /frontend/out ./frontend/out

# create data/cache and artifacts dirs
RUN mkdir -p data/cache models/artifacts

# default: start API server
# override CMD in docker-compose for UI service
EXPOSE 8000 8501

CMD ["python", "-m", "uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000"]
