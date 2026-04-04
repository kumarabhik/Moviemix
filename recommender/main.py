from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from typing import Any, Dict, List, Optional
import ast
import numpy as np
import time
import os
import re
import pandas as pd
import psycopg2
import faiss
from sentence_transformers import SentenceTransformer
import xgboost as xgb
from prometheus_fastapi_instrumentator import Instrumentator


# ---------------------------
# Configuration
# ---------------------------
DB_URL = os.getenv("DATABASE_URL")
if not DB_URL:
    raise RuntimeError("DATABASE_URL is required for recommender service startup.")
DATA_DIR = os.getenv("DATA_DIR", "/app/data")
os.makedirs(DATA_DIR, exist_ok=True)

EMB_FILE = os.path.join(DATA_DIR, "embeddings.npy")
ID_FILE = os.path.join(DATA_DIR, "title_ids.npy")
META_CSV = os.path.join(DATA_DIR, "titles_meta.csv")
INDEX_FP = os.path.join(DATA_DIR, "faiss.index")
XGB_MODEL_PATH = os.getenv("XGB_MODEL_PATH", os.path.join(DATA_DIR, "xgb_reranker.json"))

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


class XgbRerankReq(BaseModel):
    candidates: List[Dict[str, Any]]
    topK: Optional[int] = None


# ---------------------------
# In-memory handles
# ---------------------------
_model: Optional[SentenceTransformer] = None
_index: Optional[faiss.Index] = None
_title_ids: Optional[np.ndarray] = None
_meta: Optional[pd.DataFrame] = None
_embeddings: Optional[np.ndarray] = None
_id_to_idx: Dict[int, int] = {}
_title_names: Optional[np.ndarray] = None
_title_norms: Optional[np.ndarray] = None
_title_token_sets: List[frozenset[str]] = []
_title_token_sizes: Optional[np.ndarray] = None
_title_norm_to_indices: Dict[str, np.ndarray] = {}
_token_to_indices: Dict[str, np.ndarray] = {}

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
    "user_user_cf",
    "user_user_supporters",
    "source_semantic",
    "source_popular",
    "source_neighbor",
    "seen_by_user",
    "novelty_score",
]


def _normalize_title(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())
    return " ".join(cleaned.split())


def _safe_list(value) -> List[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, tuple):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, np.ndarray):
        return [str(v).strip() for v in value.tolist() if str(v).strip()]
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return []
        try:
            parsed = ast.literal_eval(text)
            if isinstance(parsed, (list, tuple)):
                return [str(v).strip() for v in parsed if str(v).strip()]
        except Exception:
            pass
        return [text]
    return []


def _safe_float(value) -> float:
    try:
        return float(value)
    except Exception:
        return 0.0


def _build_search_text(name: str, plot: str, genres=None, cast_names=None, year=None) -> str:
    title = str(name or "").strip()
    overview = str(plot or "").strip()
    genres_list = _safe_list(genres)
    cast_list = _safe_list(cast_names)[:6]
    year_val = str(int(year)) if str(year or "").strip() else ""

    parts = []
    if title:
        # Repeat the title in a few natural contexts so title queries map
        # closer to the actual item embedding.
        parts.extend(
            [
                f"Title: {title}.",
                f"Movie: {title}.",
                f"{title}.",
            ]
        )
    if year_val:
        parts.append(f"Release year: {year_val}.")
    if genres_list:
        genre_text = ", ".join(genres_list)
        parts.extend(
            [
                f"Genres: {genre_text}.",
                f"This is a {genre_text} story.",
            ]
        )
    if cast_list:
        parts.append(f"Cast: {', '.join(cast_list)}.")
    if overview:
        parts.append(f"Overview: {overview}")

    return " ".join(p for p in parts if p)


def _ensure_meta_shape(meta: pd.DataFrame) -> pd.DataFrame:
    df = meta.copy()
    for col, default in {
        "id": None,
        "name": "",
        "text": "",
        "genres": "",
        "cast_names": "",
        "year": "",
    }.items():
        if col not in df.columns:
            df[col] = default

    df["name"] = df["name"].fillna("").astype(str)
    df["text"] = df["text"].fillna("").astype(str)
    df["genres"] = df["genres"].apply(_safe_list)
    df["cast_names"] = df["cast_names"].apply(_safe_list)
    df["title_norm"] = df["name"].apply(_normalize_title)
    return df


def _refresh_lookup_state():
    global _id_to_idx, _meta
    global _title_names, _title_norms, _title_token_sets, _title_token_sizes
    global _title_norm_to_indices, _token_to_indices
    if _title_ids is None or _meta is None:
        _id_to_idx = {}
        _title_names = None
        _title_norms = None
        _title_token_sets = []
        _title_token_sizes = None
        _title_norm_to_indices = {}
        _token_to_indices = {}
        return
    _meta = _ensure_meta_shape(_meta)
    _id_to_idx = {int(title_id): idx for idx, title_id in enumerate(_title_ids.tolist())}
    _title_names = _meta["name"].fillna("").astype(str).to_numpy(dtype=str, copy=True)
    _title_norms = _meta["title_norm"].fillna("").astype(str).to_numpy(dtype=str, copy=True)

    title_token_sets: List[frozenset[str]] = []
    title_token_sizes = np.zeros(len(_title_norms), dtype=np.int16)
    title_norm_to_indices: Dict[str, List[int]] = {}
    token_to_indices: Dict[str, List[int]] = {}

    for idx, title_norm in enumerate(_title_norms):
        title_norm_to_indices.setdefault(title_norm, []).append(idx)
        tokens = frozenset(title_norm.split())
        title_token_sets.append(tokens)
        title_token_sizes[idx] = len(tokens)
        for token in tokens:
            token_to_indices.setdefault(token, []).append(idx)

    _title_token_sets = title_token_sets
    _title_token_sizes = title_token_sizes
    _title_norm_to_indices = {
        title_norm: np.asarray(indices, dtype=np.int32)
        for title_norm, indices in title_norm_to_indices.items()
    }
    _token_to_indices = {
        token: np.asarray(indices, dtype=np.int32)
        for token, indices in token_to_indices.items()
    }


def _candidate_indices_for_tokens(tokens: List[str]) -> np.ndarray:
    candidate_groups = [_token_to_indices[token] for token in tokens if token in _token_to_indices]
    if not candidate_groups:
        return np.empty(0, dtype=np.int32)
    if len(candidate_groups) == 1:
        return candidate_groups[0]
    return np.unique(np.concatenate(candidate_groups))


def _title_match_scores(query_norm: str, candidate_indices: np.ndarray) -> np.ndarray:
    if (
        not query_norm
        or candidate_indices.size == 0
        or _title_norms is None
        or _title_token_sizes is None
    ):
        return np.zeros(candidate_indices.size, dtype=np.float32)

    candidate_titles = _title_norms[candidate_indices]
    scores = np.zeros(candidate_indices.size, dtype=np.float32)
    nonempty_title_mask = candidate_titles != ""

    exact_mask = candidate_titles == query_norm
    scores[exact_mask] = 1.0

    prefix_mask = (~exact_mask) & nonempty_title_mask
    if prefix_mask.any():
        prefix_scores = np.fromiter(
            (
                0.82 if (title.startswith(query_norm) or query_norm.startswith(title)) else 0.0
                for title in candidate_titles[prefix_mask]
            ),
            dtype=np.float32,
            count=int(prefix_mask.sum()),
        )
        scores[prefix_mask] = np.maximum(scores[prefix_mask], prefix_scores)

    contains_mask = (scores < 0.68) & nonempty_title_mask
    if contains_mask.any():
        contains_scores = np.fromiter(
            (
                0.68 if (query_norm in title or title in query_norm) else 0.0
                for title in candidate_titles[contains_mask]
            ),
            dtype=np.float32,
            count=int(contains_mask.sum()),
        )
        scores[contains_mask] = np.maximum(scores[contains_mask], contains_scores)

    q_tokens = frozenset(query_norm.split())
    jaccard_mask = scores < 0.5
    if q_tokens and jaccard_mask.any():
        overlap = np.fromiter(
            (len(q_tokens & _title_token_sets[idx]) for idx in candidate_indices[jaccard_mask]),
            dtype=np.float32,
            count=int(jaccard_mask.sum()),
        )
        union = (
            np.float32(len(q_tokens))
            + _title_token_sizes[candidate_indices[jaccard_mask]].astype(np.float32)
            - overlap
        )
        jaccard_scores = np.divide(
            overlap,
            union,
            out=np.zeros_like(overlap),
            where=union > 0,
        )
        scores[jaccard_mask] = np.maximum(scores[jaccard_mask], jaccard_scores)

    return scores


def _find_anchor_indices(query_norm: str, max_matches: int = 5) -> List[int]:
    if not query_norm or _title_norms is None:
        return []

    exact_indices = _title_norm_to_indices.get(query_norm)
    if exact_indices is not None and exact_indices.size:
        return exact_indices[:max_matches].tolist()

    contains_indices = np.flatnonzero(np.char.find(_title_norms, query_norm) >= 0)
    if contains_indices.size:
        return contains_indices[:max_matches].tolist()

    q_tokens = query_norm.split()
    if not q_tokens:
        return []

    candidate_indices = _candidate_indices_for_tokens(q_tokens)
    if candidate_indices.size == 0:
        return []

    scores = _title_match_scores(query_norm, candidate_indices)
    valid_mask = scores >= 0.5
    if not valid_mask.any():
        return []

    candidate_indices = candidate_indices[valid_mask]
    scores = scores[valid_mask]
    order = np.lexsort((-candidate_indices, -scores))
    return candidate_indices[order][:max_matches].tolist()


def _search_with_query_vectors(query_vectors: List[np.ndarray], weights: List[float], candidate_pool: int):
    if _index is None:
        return (
            np.empty(0, dtype=np.int32),
            np.empty(0, dtype=np.float32),
        )

    combined = np.zeros(int(_index.ntotal), dtype=np.float32)
    touched: List[np.ndarray] = []
    for vec, weight in zip(query_vectors, weights):
        D, I = _index.search(vec, candidate_pool)
        valid_mask = I[0] >= 0
        if not valid_mask.any():
            continue
        indices = I[0][valid_mask].astype(np.int32, copy=False)
        weighted_scores = D[0][valid_mask].astype(np.float32, copy=False) * np.float32(weight)
        np.add.at(combined, indices, weighted_scores)
        touched.append(indices)

    if not touched:
        return (
            np.empty(0, dtype=np.int32),
            np.empty(0, dtype=np.float32),
        )

    candidate_indices = np.unique(np.concatenate(touched))
    return candidate_indices, combined[candidate_indices]


def _dedupe_items_by_title(items):
    seen = set()
    out = []
    for it in items or []:
        title = _normalize_title(it.get("title"))
        title_id = it.get("title_id")
        key = f"title:{title}" if title else f"id:{title_id}"
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def _load_xgb_model():
    """
    Load XGBoost reranker model from durable storage first, then fall back
    to the legacy code-local path for older setups.
    """
    global XGB_MODEL

    here = os.path.dirname(os.path.abspath(__file__))  # /app
    candidate_paths = [
        XGB_MODEL_PATH,
        os.path.join(here, "xgb_reranker.json"),
    ]
    model_path = next((p for p in candidate_paths if os.path.exists(p)), None)

    if not model_path:
        print(
            "[xgb] model not found; checked: "
            + ", ".join(candidate_paths)
            + ". reranker disabled."
        )
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
    """
    if not candidates:
        return np.zeros((0, len(FEATURE_COLUMNS)), dtype=np.float32)

    cols = []
    for col in FEATURE_COLUMNS:
        values = np.fromiter(
            (
                _safe_float(
                    it.get("score") if col == "semantic_score" and it.get(col) is None else it.get(col)
                )
                for it in candidates
            ),
            dtype=np.float32,
            count=len(candidates),
        )
        cols.append(values)

    return np.column_stack(cols).astype(np.float32, copy=False)


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
    global _index, _title_ids, _meta, _embeddings
    if (
        os.path.exists(INDEX_FP)
        and os.path.exists(EMB_FILE)
        and os.path.exists(ID_FILE)
        and os.path.exists(META_CSV)
    ):
        try:
            _index = faiss.read_index(INDEX_FP)
            _embeddings = np.load(EMB_FILE)
            _title_ids = np.load(ID_FILE)
            _meta = _ensure_meta_shape(pd.read_csv(META_CSV))
            _refresh_lookup_state()
            return True
        except Exception:
            # reset on failure
            _index = None
            _embeddings = None
            _title_ids = None
            _meta = None
            _refresh_lookup_state()
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
            "/admin/reload_xgb",
            "/recs/semantic",
            "/recs/content",
            "/rerank/xgb",
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
    global _index, _title_ids, _meta, _embeddings
    _index = None
    _title_ids = None
    _meta = None
    _embeddings = None
    _refresh_lookup_state()
    return {"ok": True}


@app.post("/admin/reload_xgb")
def reload_xgb():
    _load_xgb_model()
    return {"ok": True, "model_loaded": XGB_MODEL is not None}


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
        sql = """
            SELECT id, name, plot, genres, cast_names, year
            FROM titles
            ORDER BY id ASC
        """
        if req.limit and req.limit > 0:
            sql += f" LIMIT {int(req.limit)}"
        cur.execute(sql)
        rows = cur.fetchall()

    if not rows:
        raise HTTPException(400, "No titles found. Seed first.")

    ids: List[int] = []
    texts: List[str] = []
    names: List[str] = []
    genres_meta: List[List[str]] = []
    cast_meta: List[List[str]] = []
    years_meta: List[Optional[int]] = []

    for _id, name, plot, genres, cast_names, year in rows:
        ids.append(_id)
        names.append(name or "")
        genres_meta.append(_safe_list(genres))
        cast_meta.append(_safe_list(cast_names))
        years_meta.append(year)
        text = _build_search_text(name or "", plot or "", genres, cast_names, year)
        if not text.strip():
            text = name or str(_id)
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
    pd.DataFrame(
        {
            "id": ids,
            "name": names,
            "text": texts,
            "genres": genres_meta,
            "cast_names": cast_meta,
            "year": years_meta,
        }
    ).to_csv(META_CSV, index=False)
    faiss.write_index(index, INDEX_FP)

    # Load in memory for immediate use
    global _index, _title_ids, _meta, _embeddings
    _index = index
    _embeddings = emb
    _title_ids = np.array(ids, dtype=np.int32)
    _meta = _ensure_meta_shape(
        pd.DataFrame(
            {
                "id": ids,
                "name": names,
                "text": texts,
                "genres": genres_meta,
                "cast_names": cast_meta,
                "year": years_meta,
            }
        )
    )
    _refresh_lookup_state()

    return {"ok": True, "count": int(index.ntotal)}


@app.post("/recs/semantic", response_model=List[RecItem])
def recs_semantic(req: SemanticReq):
    """
    Semantic recommendations using FAISS over (plot/name) embeddings,
    optionally reranked with XGBoost if available.
    """
    global _index, _title_ids, _meta, _embeddings

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

    top_k = max(1, int(req.topK or 10))
    query_norm = _normalize_title(req.query)
    anchor_indices = _find_anchor_indices(query_norm)

    query_vectors = [q]
    weights = [1.0]
    if anchor_indices and _embeddings is not None:
        anchor_vec = np.mean(_embeddings[anchor_indices], axis=0, keepdims=True).astype(
            "float32"
        )
        anchor_vec = _normalize(anchor_vec)
        query_vectors = [q, anchor_vec]
        # Title-aware search should strongly influence movie-title queries,
        # while still keeping some room for free-text intent.
        weights = [0.45, 0.85]

    candidate_pool = max(top_k * 12, 80)
    candidate_pool = min(candidate_pool, int(_index.ntotal))

    # 2) Run one or more semantic searches and fuse their scores.
    ranked_indices, semantic_scores = _search_with_query_vectors(
        query_vectors, weights, candidate_pool
    )
    if ranked_indices.size == 0:
        return []

    order = np.lexsort((-ranked_indices, -semantic_scores))
    ranked_indices = ranked_indices[order]
    semantic_scores = semantic_scores[order]
    title_bonuses = _title_match_scores(query_norm, ranked_indices)

    # 3) Collect candidates as dicts, blending in a title-match bonus.
    items = []
    for idx, semantic_score, title_bonus in zip(ranked_indices, semantic_scores, title_bonuses):
        title_id = int(_title_ids[idx])
        title = (
            str(_title_names[idx])
            if _title_names is not None and idx < len(_title_names)
            else f"Title {title_id}"
        )
        final_score = float(semantic_score) + (0.45 * float(title_bonus))
        items.append(
            {
                "title_id": title_id,
                "title": title,
                "score": final_score,
                "semantic_score": float(semantic_score),
                "title_match_score": float(title_bonus),
            }
        )

    # 4) Rerank with XGBoost if model is loaded
    items = rerank_with_xgb(items)
    items = _dedupe_items_by_title(items)
    items = items[:top_k]

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

    # Use a wider semantic pool, then remove seed-title self matches.
    top_k = max(1, int(req.topK or 10))
    seed_norm = _normalize_title(req.seed_text)
    base = recs_semantic(SemanticReq(query=req.seed_text, topK=max(top_k * 3, 30)))

    filtered = []
    for it in base:
        title_norm = _normalize_title(it.title)
        if seed_norm and title_norm == seed_norm:
            continue
        filtered.append(it)

    return filtered[:top_k]


@app.post("/rerank/xgb")
def rerank_xgb(req: XgbRerankReq):
    """
    Score arbitrary candidate rows using the loaded XGBoost model.
    The backend assembles user-aware features and this endpoint applies
    the trained reranker consistently from the Python service.
    """
    global XGB_MODEL

    items = [dict(it) for it in (req.candidates or []) if isinstance(it, dict)]
    if not items:
        return {"ok": True, "model_loaded": XGB_MODEL is not None, "items": []}

    if XGB_MODEL is None:
        return {"ok": True, "model_loaded": False, "items": items}

    X = build_features_for_candidates(items)
    dmat = xgb.DMatrix(X, feature_names=FEATURE_COLUMNS)
    preds = XGB_MODEL.predict(dmat)

    for it, score in zip(items, preds):
        it["xgb_score"] = float(score)

    items = sorted(items, key=lambda x: x.get("xgb_score", 0.0), reverse=True)
    top_k = max(1, int(req.topK or len(items)))
    return {"ok": True, "model_loaded": True, "items": items[:top_k]}
