FROM python:3.14-slim-trixie@sha256:b877e50bd90de10af8d82c57a022fc2e0dc731c5320d762a27986facfc3355c1

ENV PYTHONDONTWRITEBYTECODE=1 \
  PYTHONUNBUFFERED=1 \
  PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends libgomp1 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN python -m pip install --upgrade pip setuptools wheel \
  && pip install -r requirements.txt \
  && python -m pip uninstall -y pip setuptools wheel \
  && apt-get purge -y --auto-remove build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY app.py .

ENV HF_HOME=/app/hf-cache

RUN useradd --no-create-home --shell /bin/false tagger \
  && mkdir -p /app/hf-cache \
  && chown -R tagger:tagger /app

USER tagger

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
