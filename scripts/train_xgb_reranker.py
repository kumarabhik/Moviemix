import os

import numpy as np
import pandas as pd
import xgboost as xgb

BASE_DIR = os.path.dirname(__file__)
CSV_PATH = os.path.abspath(
    os.path.join(BASE_DIR, "..", "data", "xgb_rerank_dataset.csv")
)
MODELS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "models"))
MODEL_PATH = os.path.join(MODELS_DIR, "xgb_reranker.json")
RECOMMENDER_DATA_DIR = os.path.abspath(
    os.path.join(BASE_DIR, "..", "recommender", "data")
)
RECOMMENDER_MODEL_PATH = os.path.join(RECOMMENDER_DATA_DIR, "xgb_reranker.json")

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
LABEL_COLUMN = "label"
USER_COLUMN = "user_id"
QUERY_COLUMN = "query_id"


def split_by_user(df, train_ratio=0.8, seed=42):
    users = df[USER_COLUMN].astype(str).unique()
    if len(users) <= 1:
        return df.copy(), df.iloc[0:0].copy()

    rng = np.random.default_rng(seed)
    rng.shuffle(users)
    split_at = max(1, int(len(users) * train_ratio))
    split_at = min(split_at, len(users) - 1)

    train_users = set(users[:split_at])
    valid_users = set(users[split_at:])
    train_df = df[df[USER_COLUMN].astype(str).isin(train_users)].copy()
    valid_df = df[df[USER_COLUMN].astype(str).isin(valid_users)].copy()
    return train_df, valid_df


def prepare_ranking_frame(df):
    if df.empty:
        return df.copy(), []

    work = df.copy()
    work = work.sort_values([QUERY_COLUMN, LABEL_COLUMN], ascending=[True, False]).reset_index(
        drop=True
    )
    group_sizes = work.groupby(QUERY_COLUMN, sort=False).size().tolist()
    return work, group_sizes


def build_dmatrix(df):
    frame, group_sizes = prepare_ranking_frame(df)
    X = frame[FEATURE_COLUMNS].astype(float)
    y = frame[LABEL_COLUMN].astype(float)
    dmat = xgb.DMatrix(X, label=y, feature_names=FEATURE_COLUMNS)
    dmat.set_group(group_sizes)
    return frame, dmat, group_sizes


def main():
    if not os.path.exists(CSV_PATH):
        raise FileNotFoundError(f"Training CSV not found at: {CSV_PATH}")

    print(f"[xgb-train] loading dataset from {CSV_PATH}")
    df = pd.read_csv(CSV_PATH)

    required = FEATURE_COLUMNS + [LABEL_COLUMN, USER_COLUMN, QUERY_COLUMN]
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns in CSV: {missing}")

    df = df.dropna(subset=[USER_COLUMN, QUERY_COLUMN]).copy()
    if df.empty:
        raise ValueError("Training dataset is empty after dropping invalid rows")

    for col in FEATURE_COLUMNS + [LABEL_COLUMN]:
        df[col] = pd.to_numeric(df[col], errors="coerce").fillna(0.0)

    train_df, valid_df = split_by_user(df, train_ratio=0.8, seed=42)
    train_df = train_df.groupby(QUERY_COLUMN).filter(lambda g: g[LABEL_COLUMN].max() > 0).copy()
    valid_df = valid_df.groupby(QUERY_COLUMN).filter(lambda g: g[LABEL_COLUMN].max() > 0).copy()

    if train_df.empty:
        raise ValueError("No training groups with positive labels were found")

    train_frame, dtrain, train_groups = build_dmatrix(train_df)
    evals = [(dtrain, "train")]

    print(
        "[xgb-train] rows="
        f"{len(df)} train_rows={len(train_df)} valid_rows={len(valid_df)} "
        f"users={df[USER_COLUMN].nunique()} train_queries={len(train_groups)}"
    )
    print(
        "[xgb-train] positives="
        f"{int((train_df[LABEL_COLUMN] > 0).sum())} "
        f"valid_positives={int((valid_df[LABEL_COLUMN] > 0).sum()) if not valid_df.empty else 0}"
    )

    valid_dmatrix = None
    if not valid_df.empty:
        _, valid_dmatrix, valid_groups = build_dmatrix(valid_df)
        evals.append((valid_dmatrix, "valid"))
        print(f"[xgb-train] valid_queries={len(valid_groups)}")

    params = {
        "objective": "rank:ndcg",
        "eval_metric": ["ndcg@10", "ndcg@20"],
        "eta": 0.05,
        "max_depth": 6,
        "min_child_weight": 2,
        "subsample": 0.9,
        "colsample_bytree": 0.9,
        "lambda": 1.0,
        "alpha": 0.1,
        "tree_method": "hist",
        "seed": 42,
    }

    print("[xgb-train] training ranking XGBoost reranker...")
    if valid_dmatrix is not None:
        model = xgb.train(
            params,
            dtrain,
            num_boost_round=500,
            evals=evals,
            early_stopping_rounds=40,
            verbose_eval=25,
        )
    else:
        model = xgb.train(
            params,
            dtrain,
            num_boost_round=500,
            evals=evals,
            verbose_eval=25,
        )

    os.makedirs(MODELS_DIR, exist_ok=True)
    os.makedirs(RECOMMENDER_DATA_DIR, exist_ok=True)
    model.save_model(MODEL_PATH)
    model.save_model(RECOMMENDER_MODEL_PATH)

    print(f"[xgb-train] saved -> {MODEL_PATH}")
    print(f"[xgb-train] saved -> {RECOMMENDER_MODEL_PATH}")

    importance = model.get_score(importance_type="gain")
    if importance:
        ranked = sorted(importance.items(), key=lambda x: x[1], reverse=True)
        print("[xgb-train] top features:")
        for name, gain in ranked[:8]:
            print(f"  - {name}: {gain:.4f}")


if __name__ == "__main__":
    main()
