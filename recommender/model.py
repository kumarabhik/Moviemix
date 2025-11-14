from typing import List, Tuple
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

class TfidfRecommender:
    def __init__(self):
        self.vectorizer = TfidfVectorizer(
            stop_words="english",
            max_df=0.8,
            min_df=2,
            ngram_range=(1,2)
        )
        self.matrix = None
        self.df = None

    def _combine(self, row: pd.Series) -> str:
        parts = [str(row.get("name","")), str(row.get("plot",""))]
        genres = row.get("genres")
        if isinstance(genres, list):
            parts.append(" ".join(genres))
        return " ".join(p for p in parts if p and p != "nan")

    def fit(self, df: pd.DataFrame):
        # Expect columns: id, imdb_id, name, plot, genres
        self.df = df.copy()
        self.df["text"] = self.df.apply(self._combine, axis=1)
        X = self.vectorizer.fit_transform(self.df["text"])
        self.matrix = X

    def topk_by_text(self, seed_text: str, k: int = 10) -> List[Tuple[int, float]]:
        if self.matrix is None: return []
        q = self.vectorizer.transform([seed_text])
        sims = cosine_similarity(q, self.matrix)[0]
        idxs = sims.argsort()[::-1][:k]
        return [(int(self.df.iloc[i]["id"]), float(sims[i])) for i in idxs]

    def topk_like_id(self, row_id: int, k: int = 10) -> List[Tuple[int, float]]:
        if self.matrix is None: return []
        row = self.df.index[self.df["id"] == row_id]
        if len(row) == 0: return []
        i = int(row[0])
        sims = cosine_similarity(self.matrix[i], self.matrix)[0]
        idxs = sims.argsort()[::-1]
        idxs = [j for j in idxs if j != i][:k]
        return [(int(self.df.iloc[j]["id"]), float(sims[j])) for j in idxs]
