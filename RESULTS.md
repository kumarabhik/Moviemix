# Benchmark Results

## SIMD-Friendly Recommender Optimization

This document records the latency benchmark results for the recommender optimization added in [`recommender/main.py`](recommender/main.py).

## What Changed

- cached normalized title metadata and token lookups
- replaced Python-level score fusion loops with NumPy accumulation
- reused vectorized title-match scoring during semantic ranking
- kept FAISS and XGBoost behavior intact

## Benchmark Scope

The benchmark uses [`scripts/benchmark_recommender.py`](scripts/benchmark_recommender.py).

It measures:

- the semantic ranking stage inside the recommender
- `avg`, `p50`, and `p95` latency
- current worktree versus `HEAD`

It does **not** include:

- live HTTP overhead
- `SentenceTransformer.encode(...)` time

The benchmark replays stored embedding vectors so it isolates the ranking/search path.

## Command Used

```powershell
.\venv\Scripts\python.exe scripts\benchmark_recommender.py --iterations 200 --warmup 20 --sample-size 24
```

Sanity-check run used earlier:

```powershell
.\venv\Scripts\python.exe scripts\benchmark_recommender.py --iterations 60 --warmup 10 --sample-size 12
```

## Primary Result

Configuration:

- sample titles: `24`
- iterations per variant: `200`
- warm-up per variant: `20`

| Metric | HEAD Baseline | Current Worktree | Latency Decrease |
|---|---:|---:|---:|
| Average | `19.26 ms` | `10.72 ms` | `44.36%` |
| P50 | `17.95 ms` | `9.97 ms` | `44.44%` |
| P95 | `23.13 ms` | `13.14 ms` | `43.18%` |

## Secondary Result

Configuration:

- sample titles: `12`
- iterations per variant: `60`
- warm-up per variant: `10`

| Metric | HEAD Baseline | Current Worktree | Latency Decrease |
|---|---:|---:|---:|
| Average | `20.34 ms` | `11.64 ms` | `42.75%` |
| P50 | `18.98 ms` | `10.77 ms` | `43.24%` |
| P95 | `24.45 ms` | `16.28 ms` | `33.38%` |

## Offline Evaluation Metrics

The offline evaluator in [`scripts/eval_offline.py`](scripts/eval_offline.py) was also updated to report:

- `Precision@K`
- `Recall@K`
- `NDCG@K`
- `HitRate@K`
- `MRR@K`
- `Genre-match@K`
- `Novelty@K`
- `Coverage@K`

This run used a practical sample configuration so the personalized recommender could finish in a reasonable time on the local stack:

- users evaluated: `5`
- holdout count: `3`
- topK: `20`
- metric Ks: `10, 20`

Command context:

- backend, recommender, and db were started locally with Docker Compose
- evaluation used signed local JWTs via `JWT_SECRET`
- host-side evaluation pointed at the local backend on `http://localhost:8000`

### Offline Summary

| Metric | Value |
|---|---:|
| Precision@10 | `0.280` |
| Recall@10 | `0.933` |
| NDCG@10 | `0.940` |
| HitRate@10 | `1.000` |
| MRR@10 | `1.000` |
| Precision@20 | `0.140` |
| Recall@20 | `0.933` |
| NDCG@20 | `0.940` |
| HitRate@20 | `1.000` |
| MRR@20 | `1.000` |
| Genre-match@20 | `0.870` |
| Novelty@20 | `15.679` |
| Coverage@20 | `91 unique titles` |

### Notes On These Metrics

- `Genre-match@20` was corrected after normalizing both user-profile genres and recommended-title genres to the same lowercase format inside the evaluator.
- These offline metrics are not directly comparable to the latency benchmark above; they measure recommendation quality, not runtime speed.
- The sample used `5` users rather than the full user set because the personalized route is significantly more expensive at larger evaluation settings.

## Blog-Ready Summary

The recommender optimization reduced isolated semantic ranking latency by about `44%` on the local benchmark. In the larger benchmark run, average latency dropped from `19.26 ms` to `10.72 ms`, and p95 latency dropped from `23.13 ms` to `13.14 ms`.

## Interpretation Notes

- The most reliable number to quote is the larger run above.
- Real end-to-end API latency will usually improve by less than `44%`, because embedding generation and network overhead are not included in this benchmark.
- The benchmark still gives a strong signal that the ranking/search portion became substantially faster.

## How To Reproduce

```powershell
.\venv\Scripts\python.exe scripts\benchmark_recommender.py
```

For a single-title test:

```powershell
.\venv\Scripts\python.exe scripts\benchmark_recommender.py --query "The Dark Knight" --iterations 300
```
