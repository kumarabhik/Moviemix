from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import numpy as np
import time
import os
import pandas as pd
import psycopg2
import faiss
from sentence_transformers import SentenceTransformer
import xgboost as xgb
from prometheus_fastapi_instrumentator import Instrumentator


# ---------------------------
# Configuration
# ---------------------------
DB_URL = os.getenv("DATABASE_URL", "postgresql://admin:I4mGr00t@db:5432/moviemix")
DATA_DIR = os.getenv("DATA_DIR", "/app/data")
os.makedirs(DATA_DIR, exist_ok=True)

EMB_FILE = os.path.join(DATA_DIR, "embeddings.npy")
ID_FILE = os.path.join(DATA_DIR, "title_ids.npy")
META_CSV = os.path.join(DATA_DIR, "titles_meta.csv")
INDEX_FP = os.path.join(DATA_DIR, "faiss.index")

MODEL_NAME = os.getenv("EMB_MODEL", "sentence-transformers/all-MiniLM-L6-v2")

# ---------------------------
# FastAPI App
# ---------------------------
app = FastAPI(title="MovieMix Recommender", version="0.2.0")
# Prometheus /metrics for FastAPI
Instrumentator().instrument(app).expose(app)

# ---------------------------
# Schemas
# ---------------------------
class ContentReq(BaseModel):
    seed_text: Optional[str] = None
    topK: int = 10


class SemanticReq(BaseModel):
    query: Optional[str] = None
    topK: int = 10


class BuildReq(BaseModel):
    limit: Optional[int] = None  # limit rows during quick tests


class RecItem(BaseModel):
    title_id: int
    title: str
    score: float


# ---------------------------
# In-memory handles
# ---------------------------
_model: Optional[SentenceTransformer] = None
_index: Optional[faiss.Index] = None
_title_ids: Optional[np.ndarray] = None
_meta: Optional[pd.DataFrame] = None

# ---------------------------
# XGBoost model + feature builder
# ---------------------------
XGB_MODEL = None

FEATURE_COLUMNS = [
    "semantic_score",
    "log_popularity",
    "same_year",
    "genre_overlap_seed",
    "genre_overlap_user",
    "in_user_wishlist",
]


def _load_xgb_model():
    """
    Load XGBoost reranker model from the same folder as main.py
    -> /app/xgb_reranker.json inside the container.
    """
    global XGB_MODEL

    here = os.path.dirname(os.path.abspath(__file__))  # /app
    model_path = os.path.join(here, "xgb_reranker.json")  # /app/xgb_reranker.json

    if not os.path.exists(model_path):
        print(f"[xgb] model not found at {model_path}, reranker disabled.")
        XGB_MODEL = None
        return

    try:
        booster = xgb.Booster()
        booster.load_model(model_path)
        XGB_MODEL = booster
        print(f"[xgb] loaded reranker model from {model_path}")
    except Exception as e:
        print(f"[xgb] failed to load model: {e}")
        XGB_MODEL = None


def build_features_for_candidates(candidates):
    """
    candidates: list of dicts with at least `score` (semantic similarity).
    Returns a NumPy array shape [N, len(FEATURE_COLUMNS)].
    For now we only use semantic_score and set other features to 0.
    """
    X = []
    for it in candidates:
        sem = float(it.get("score") or 0.0)

        # placeholders for now; wire real features later
        log_pop = 0.0
        same_year = 0.0
        genre_seed = 0.0
        genre_user = 0.0
        in_wishlist = 0.0

        feats = [
            sem,
            log_pop,
            same_year,
            genre_seed,
            genre_user,
            in_wishlist,
        ]
        X.append(feats)

    if not X:
        return np.zeros((0, len(FEATURE_COLUMNS)), dtype=np.float32)

    return np.array(X, dtype=np.float32)


def rerank_with_xgb(candidates):
    """
    candidates: [{title_id, title, score, ...}, ...]
    Returns a *new* list sorted by XGBoost score (desc) if model is loaded,
    otherwise returns the list as-is.
    """
    global XGB_MODEL
    if XGB_MODEL is None or not candidates:
        return candidates

    X = build_features_for_candidates(candidates)
    dmat = xgb.DMatrix(X, feature_names=FEATURE_COLUMNS)
    preds = XGB_MODEL.predict(dmat)

    # attach predicted score and sort
    for it, s in zip(candidates, preds):
        it["xgb_score"] = float(s)

    candidates = sorted(candidates, key=lambda x: x["xgb_score"], reverse=True)
    return candidates


# ---------------------------
# Utilities
# ---------------------------
def _connect():
    """Create a new DB connection (psycopg2)."""
    return psycopg2.connect(DB_URL)


def _normalize(x: np.ndarray) -> np.ndarray:
    """L2 normalize for cosine-sim via inner product in FAISS."""
    norms = np.linalg.norm(x, axis=1, keepdims=True) + 1e-12
    return x / norms


def _get_model() -> SentenceTransformer:
    """Lazy-load the embedding model once."""
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def _load_index_if_exists() -> bool:
    """Load FAISS index and meta artifacts from disk if present."""
    global _index, _title_ids, _meta
    if (
        os.path.exists(INDEX_FP)
        and os.path.exists(EMB_FILE)
        and os.path.exists(ID_FILE)
        and os.path.exists(META_CSV)
    ):
        try:
            _index = faiss.read_index(INDEX_FP)
            _title_ids = np.load(ID_FILE)
            _meta = pd.read_csv(META_CSV)
            return True
        except Exception:
            # reset on failure
            _index = None
            _title_ids = None
            _meta = None
    return False


# ---------------------------
# Startup hook
# ---------------------------
@app.on_event("startup")
def on_startup():
    # Preload index if already built (avoids 1st-request penalty)
    _load_index_if_exists()
    _load_xgb_model()


# ---------------------------
# Routes
# ---------------------------
@app.get("/")
def root():
    return {
        "ok": True,
        "service": "recommender",
        "version": "0.2.0",
        "routes": [
            "/health",
            "/admin/build_embeddings",
            "/admin/reset",
            "/recs/semantic",
            "/recs/content",
        ],
        "ts": time.time(),
    }


@app.get("/health")
def health():
    return {"ok": True, "service": "recommender", "version": "0.2.0", "ts": time.time()}


@app.post("/admin/reset")
def reset_artifacts():
    """Delete all on-disk artifacts and clear in-memory state."""
    for p in [EMB_FILE, ID_FILE, META_CSV, INDEX_FP]:
        try:
            if os.path.exists(p):
                os.remove(p)
        except Exception as e:
            raise HTTPException(500, f"Failed to remove {p}: {e}")
    global _index, _title_ids, _meta
    _index = None
    _title_ids = None
    _meta = None
    return {"ok": True}


@app.post("/admin/build_embeddings")
def build_embeddings(req: BuildReq):
    """
    1) Pull titles from Postgres (id, name, plot)
    2) Encode with Sentence-Transformers
    3) L2-normalize embeddings
    4) Build FAISS inner-product index (cosine sim)
    5) Persist artifacts to /app/data
    """
    # 1) Load data
    with _connect() as conn, conn.cursor() as cur:
        sql = "SELECT id, name, plot FROM titles ORDER BY id ASC"
        if req.limit and req.limit > 0:
            sql += f" LIMIT {int(req.limit)}"
        cur.execute(sql)
        rows = cur.fetchall()

    if not rows:
        raise HTTPException(400, "No titles found. Seed first.")

    ids: List[int] = []
    texts: List[str] = []
    names: List[str] = []

    for _id, name, plot in rows:
        ids.append(_id)
        names.append(name or "")
        # prefer plot; fallback to name; finally id
        text = (plot or "").strip() or name or str(_id)
        texts.append(text)

    # 2) Encode
    model = _get_model()
    emb = model.encode(
        texts,
        batch_size=64,
        convert_to_numpy=True,
        show_progress_bar=False,
        normalize_embeddings=False,  # we normalize ourselves
    )

    # 3) Normalize
    emb = _normalize(emb).astype("float32")

    # 4) Build FAISS index (inner product -> cosine on normalized vectors)
    index = faiss.IndexFlatIP(emb.shape[1])
    index.add(emb)

    # 5) Persist artifacts
    np.save(EMB_FILE, emb)
    np.save(ID_FILE, np.array(ids, dtype=np.int32))
    pd.DataFrame({"id": ids, "name": names, "text": texts}).to_csv(META_CSV, index=False)
    faiss.write_index(index, INDEX_FP)

    # Load in memory for immediate use
    global _index, _title_ids, _meta
    _index = index
    _title_ids = np.array(ids, dtype=np.int32)
    _meta = pd.DataFrame({"id": ids, "name": names, "text": texts})

    return {"ok": True, "count": int(index.ntotal)}


@app.post("/recs/semantic", response_model=List[RecItem])
def recs_semantic(req: SemanticReq):
    """
    Semantic recommendations using FAISS over (plot/name) embeddings,
    optionally reranked with XGBoost if available.
    """
    global _index, _title_ids, _meta

    if _index is None:
        if not _load_index_if_exists():
            raise HTTPException(
                400, "Index not built. Call /admin/build_embeddings first."
            )

    if not req.query:
        raise HTTPException(422, "Provide 'query'")

    # 1) Encode query
    model = _get_model()
    q = model.encode(
        [req.query],
        convert_to_numpy=True,
        normalize_embeddings=False,
    )
    q = _normalize(q.astype("float32"))

    # 2) FAISS search
    D, I = _index.search(q, max(1, req.topK))
    I = I[0]
    D = D[0]

    # 3) Collect candidates as dicts
    items = []
    for idx, score in zip(I, D):
        if idx < 0:
            continue
        title_id = int(_title_ids[idx])
        name_arr = _meta.loc[_meta["id"] == title_id, "name"].values
        title = str(name_arr[0]) if len(name_arr) else f"Title {title_id}"
        items.append(
            {
                "title_id": title_id,
                "title": title,
                "score": float(score),
            }
        )

    # 4) RERANK WITH XGBOOST IF MODEL IS LOADED
    items = rerank_with_xgb(items)

    # 5) Convert back to RecItem list
    out: List[RecItem] = [
        RecItem(
            title_id=it["title_id"],
            title=it["title"],
            score=float(it.get("score", 0.0)),
        )
        for it in items
    ]

    return out


@app.post("/recs/content", response_model=List[RecItem])
def recs_content(req: ContentReq):
    """
    Content-based / 'more like this' recommendations.

    Requires:
    - seed_text: the title/name/description of the seed item
    - a built FAISS index (call /admin/build_embeddings first)
    """
    if not req.seed_text:
        raise HTTPException(400, "seed_text is required")

    # ensure index is loaded
    if _index is None and not _load_index_if_exists():
        raise HTTPException(400, "Index not built. Call /admin/build_embeddings first.")

    # delegate to the semantic pipeline
    return recs_semantic(SemanticReq(query=req.seed_text, topK=req.topK))
