import os
import pandas as pd
import xgboost as xgb

# ---------- Paths ----------
BASE_DIR = os.path.dirname(__file__)

# CSV created by your dataset builder (build_dataset script)
CSV_PATH = os.path.abspath(
    os.path.join(BASE_DIR, "..", "data", "xgb_rerank_dataset.csv")
)

# Where we will save the model
MODELS_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "models"))
MODEL_PATH = os.path.join(MODELS_DIR, "xgb_reranker.json")

# ---------- Config ----------
FEATURE_COLUMNS = [
    "semantic_score",
    "log_popularity",
    "same_year",
    "genre_overlap_seed",
    "genre_overlap_user",
    "in_user_wishlist",
]
LABEL_COLUMN = "label"


def main():
    if not os.path.exists(CSV_PATH):
        raise FileNotFoundError(f"Training CSV not found at: {CSV_PATH}")

    print(f"[xgb-train] Loading dataset from {CSV_PATH}")
    df = pd.read_csv(CSV_PATH)

    # Sanity check for required columns
    missing = [c for c in FEATURE_COLUMNS + [LABEL_COLUMN] if c not in df.columns]
    if missing:
        raise ValueError(f"Missing required columns in CSV: {missing}")

    # Features + label
    X = df[FEATURE_COLUMNS].astype(float)
    y = df[LABEL_COLUMN].astype(float)

    dtrain = xgb.DMatrix(X, label=y, feature_names=FEATURE_COLUMNS)

    params = {
        "objective": "binary:logistic",   # simple click/relevance style
        "eval_metric": "logloss",
        "eta": 0.1,
        "max_depth": 6,
        "subsample": 0.9,
        "colsample_bytree": 0.9,
        "tree_method": "hist",
    }

    num_round = 120

    print(f"[xgb-train] Training XGBoost model for {num_round} rounds...")
    model = xgb.train(
        params,
        dtrain,
        num_boost_round=num_round,
    )

    os.makedirs(MODELS_DIR, exist_ok=True)
    model.save_model(MODEL_PATH)

    print(f"[xgb-train] Saved reranker model -> {MODEL_PATH}")
    print("[xgb-train] Done.")


if __name__ == "__main__":
    main()
