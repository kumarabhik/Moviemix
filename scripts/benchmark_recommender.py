import argparse
import importlib.util
import os
import subprocess
import sys
import tempfile
import time
import types
from pathlib import Path
from typing import Any, Dict, List, Sequence, Tuple

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
RECOMMENDER_MAIN = ROOT / "recommender" / "main.py"
RECOMMENDER_DATA = ROOT / "recommender" / "data"


class FakeModel:
    def __init__(self, vector: np.ndarray):
        self.vector = np.asarray(vector, dtype=np.float32)

    def encode(self, texts: Sequence[str], **_: Any) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.vector.shape[0]), dtype=np.float32)
        return np.repeat(self.vector[np.newaxis, :], len(texts), axis=0)


def _set_benchmark_env() -> None:
    os.environ.setdefault(
        "DATABASE_URL",
        "postgresql://benchmark:benchmark@localhost:5432/moviemix",
    )
    os.environ.setdefault("DATA_DIR", str(RECOMMENDER_DATA))
    os.environ.setdefault(
        "XGB_MODEL_PATH",
        str(RECOMMENDER_DATA / "xgb_reranker.json"),
    )


def _install_optional_stubs() -> None:
    try:
        import prometheus_fastapi_instrumentator  # noqa: F401
    except Exception:
        stub = types.ModuleType("prometheus_fastapi_instrumentator")

        class _Instrumentator:
            def instrument(self, app):
                return self

            def expose(self, app):
                return self

        stub.Instrumentator = _Instrumentator
        sys.modules["prometheus_fastapi_instrumentator"] = stub


def _load_module(path: Path, module_name: str):
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module from {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _load_head_module(temp_files: List[Path]):
    content = subprocess.check_output(
        ["git", "show", "HEAD:recommender/main.py"],
        cwd=ROOT,
        text=True,
    )
    with tempfile.NamedTemporaryFile(
        mode="w",
        suffix="_recommender_head.py",
        encoding="utf-8",
        delete=False,
    ) as handle:
        handle.write(content)
        temp_path = Path(handle.name)
    temp_files.append(temp_path)
    return _load_module(temp_path, f"recommender_main_head_{os.getpid()}")


def _load_runtime(module) -> None:
    if not module._load_index_if_exists():
        raise RuntimeError(
            "Recommender artifacts are missing. Build embeddings first so recommender/data has index files."
        )
    module._load_xgb_model()


def _pick_sample_indices(total: int, sample_size: int) -> np.ndarray:
    if total <= 0:
        return np.empty(0, dtype=np.int32)
    sample_size = max(1, min(sample_size, total))
    return np.unique(np.linspace(0, total - 1, num=sample_size, dtype=np.int32))


def _resolve_query_index(module, query: str) -> int:
    query_norm = module._normalize_title(query)
    if not query_norm:
        raise RuntimeError("Query must not be empty.")

    title_norms = module._meta["title_norm"].tolist()
    for idx, title_norm in enumerate(title_norms):
        if title_norm == query_norm:
            return idx
    for idx, title_norm in enumerate(title_norms):
        if query_norm in title_norm:
            return idx

    raise RuntimeError(f"Query '{query}' was not found in recommender metadata.")


def _build_samples(module, query: str | None, sample_size: int) -> List[Tuple[str, np.ndarray]]:
    if module._meta is None or module._embeddings is None:
        raise RuntimeError("Module runtime state is not loaded.")

    if query:
        idx = _resolve_query_index(module, query)
        title = str(module._meta.iloc[idx]["name"])
        vector = np.asarray(module._embeddings[idx], dtype=np.float32)
        return [(title, vector)] * max(1, sample_size)

    nonempty = module._meta["name"].fillna("").astype(str).str.strip() != ""
    available_indices = np.flatnonzero(nonempty.to_numpy())
    if available_indices.size == 0:
        raise RuntimeError("No titled rows were found in recommender metadata.")

    chosen_positions = _pick_sample_indices(len(available_indices), sample_size)
    chosen_indices = available_indices[chosen_positions]

    samples: List[Tuple[str, np.ndarray]] = []
    for idx in chosen_indices.tolist():
        title = str(module._meta.iloc[idx]["name"])
        vector = np.asarray(module._embeddings[idx], dtype=np.float32)
        samples.append((title, vector))
    return samples


def _summarize(times_ms: Sequence[float]) -> Dict[str, float]:
    arr = np.asarray(times_ms, dtype=np.float64)
    return {
        "avg_ms": float(arr.mean()),
        "p50_ms": float(np.percentile(arr, 50)),
        "p95_ms": float(np.percentile(arr, 95)),
    }


def _pct_decrease(old: float, new: float) -> float:
    if old <= 0:
        return 0.0
    return ((old - new) / old) * 100.0


def _run_benchmark(module, samples: Sequence[Tuple[str, np.ndarray]], top_k: int, iterations: int, warmup: int):
    times_ms: List[float] = []
    request_cls = module.SemanticReq

    for i in range(max(0, warmup)):
        title, vector = samples[i % len(samples)]
        module._model = FakeModel(vector)
        module.recs_semantic(request_cls(query=title, topK=top_k))

    for i in range(iterations):
        title, vector = samples[i % len(samples)]
        module._model = FakeModel(vector)
        started = time.perf_counter()
        module.recs_semantic(request_cls(query=title, topK=top_k))
        times_ms.append((time.perf_counter() - started) * 1000.0)

    return _summarize(times_ms)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Benchmark recommender semantic ranking latency. "
            "By default this compares the current worktree against HEAD."
        )
    )
    parser.add_argument("--query", help="Benchmark one title query instead of a sample set.")
    parser.add_argument("--iterations", type=int, default=200, help="Measured requests per variant.")
    parser.add_argument("--warmup", type=int, default=20, help="Warm-up requests per variant.")
    parser.add_argument("--sample-size", type=int, default=24, help="Number of title samples when --query is omitted.")
    parser.add_argument("--top-k", type=int, default=10, help="topK passed into /recs/semantic.")
    parser.add_argument(
        "--current-only",
        action="store_true",
        help="Benchmark only the current worktree and skip the HEAD comparison.",
    )
    args = parser.parse_args()

    _set_benchmark_env()
    _install_optional_stubs()
    temp_files: List[Path] = []

    try:
        current = _load_module(RECOMMENDER_MAIN, f"recommender_main_current_{os.getpid()}")
        _load_runtime(current)
        samples = _build_samples(current, args.query, args.sample_size)

        print("Benchmark scope: semantic ranking stage only (query embedding is replayed from stored vectors).")
        if args.query:
            print(f"Query: {samples[0][0]}")
        else:
            print(f"Sample titles: {len(samples)}")
        print(f"Iterations per variant: {args.iterations}")
        print(f"Warm-up per variant: {args.warmup}")
        print("")

        current_stats = _run_benchmark(
            current,
            samples=samples,
            top_k=args.top_k,
            iterations=args.iterations,
            warmup=args.warmup,
        )

        print("Current worktree")
        print(f"  avg: {current_stats['avg_ms']:.2f} ms")
        print(f"  p50: {current_stats['p50_ms']:.2f} ms")
        print(f"  p95: {current_stats['p95_ms']:.2f} ms")

        if args.current_only:
            return 0

        print("")
        head = _load_head_module(temp_files)
        _load_runtime(head)
        head_stats = _run_benchmark(
            head,
            samples=samples,
            top_k=args.top_k,
            iterations=args.iterations,
            warmup=args.warmup,
        )

        print("HEAD baseline")
        print(f"  avg: {head_stats['avg_ms']:.2f} ms")
        print(f"  p50: {head_stats['p50_ms']:.2f} ms")
        print(f"  p95: {head_stats['p95_ms']:.2f} ms")
        print("")

        print("Latency decrease vs HEAD")
        print(f"  avg: {_pct_decrease(head_stats['avg_ms'], current_stats['avg_ms']):.2f}%")
        print(f"  p50: {_pct_decrease(head_stats['p50_ms'], current_stats['p50_ms']):.2f}%")
        print(f"  p95: {_pct_decrease(head_stats['p95_ms'], current_stats['p95_ms']):.2f}%")
        return 0
    finally:
        for path in temp_files:
            try:
                path.unlink(missing_ok=True)
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
