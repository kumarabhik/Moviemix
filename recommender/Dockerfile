FROM python:3.11-slim

WORKDIR /app

# System basics (needed for some wheels and building deps)
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy only requirements first to use layer cache
COPY requirements.txt /app/requirements.txt

# Install CPU-only PyTorch BEFORE the rest to avoid CUDA wheels
RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      torch==2.3.1 torchvision==0.18.1 torchaudio==2.3.1 \
 && pip install --no-cache-dir -r /app/requirements.txt

# Pre-cache the sentence-transformers model at build time (no runtime download)
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('sentence-transformers/all-MiniLM-L6-v2'); print('Model cached OK')"

# Now copy the rest of the code
COPY . /app

# Env + data dir
ENV DATA_DIR=/app/data \
    EMB_MODEL=sentence-transformers/all-MiniLM-L6-v2 \
    PYTHONUNBUFFERED=1

RUN mkdir -p /app/data

EXPOSE 8001

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8001"]
