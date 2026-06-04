# Why "Movies Like This" Wasn't Enough: Building MovieMix Into a Real Recommender

*How I turned a semantic movie app into a hybrid recommendation system with real user signals, Trakt import, honest evaluation, scheduled refreshes, observability, Kubernetes deployment, and a much faster ranking path.*

At the beginning, MovieMix had a neat party trick.

You could search for a movie, or ask for "movies like this", and it would return titles that felt related. That was already useful. It felt smart. It looked like a recommendation system.

But after a while I realized I was hiding behind the easiest version of the problem.

There is a big difference between:

"What movies are similar to *Interstellar*?"

and

"What should this specific person watch next?"

The first question is mostly about similarity. The second is about taste, timing, trade offs, and evidence. It forces you to care about cold start, user signals, ranking quality, latency, and whether the system is actually getting better instead of just looking plausible in a demo.

That was the moment the project changed for me.

MovieMix stopped being a search heavy app with recommendation vibes and became a real recommendation problem.

## The App Needed to Learn Taste, Not Just Titles

The first thing I had to accept was that the model was not the main problem.

The data was.

A recommender cannot personalize if it does not have anything real to learn from. So one of the most important changes I made was turning everyday product behavior into actual recommendation signals.

That meant building the product loop properly:

- signup and login with JWT auth
- a real wishlist
- profile pages
- review and interaction logging
- a "For You" flow that could eventually become truly personal

Inside the app, I started tracking events like `view`, `detail_open`, `wishlist_add`, `wishlist_remove`, `watched`, and `rate`. But I did not want those to stay as raw logs. A watch action should count more than a view. A wishlist add should count more than a casual click. A rating should carry more signal than an impression.

So the backend started converting those product events into stronger user title signals instead of just storing them as noise.

Ratings were especially useful because they gave me graded feedback instead of just binary behavior. A watch or wishlist add tells you that a user probably likes something. A rating tells you how strongly they felt about it, and that made the profile builder and reranker training data much more informative.

That gave MovieMix its first real interaction source: local app behavior.

And that ended up mattering more than a lot of the glamorous ML work, because without that layer the rest of the pipeline was always going to be weak.

## The Recommender Also Needed a Real Catalog

Before any ranking could work, the app needed something solid to rank.

I bootstrapped the base movie catalog from the `tmdb_5000_movies.csv` dataset. That gave MovieMix a practical starting set of titles, overviews, genres, popularity values, and release dates that I could import into Postgres and use for search, retrieval, and metadata generation.

That sounds simple, but it mattered a lot. A recommender is much easier to reason about when the catalog already has enough variety to support content based search, genre overlap, popularity priors, and candidate generation from more than a tiny hand entered set of titles.

I also ran into a very product shaped problem: a movie app with missing posters does not feel like a movie app for very long.

So I added OMDb enrichment for top titles that were missing metadata. That script fills in `poster_url` and plot data for popular rows, and the backend still has a fallback path that tries to fetch a poster from OMDb by IMDb ID if a title is missing one at request time.

That was a small but important piece of polish. It meant the recommendation cards were not just technically correct rows from a database. They looked like actual movies users might want to click on.

## Then I Added a Second Kind of Intent

Local behavior helped, but it did not solve cold start.

If a user is brand new, the app still knows almost nothing about them. That is where Trakt came in.

I added Trakt watchlist import so MovieMix could learn from interest the user had already expressed somewhere else. If someone had spent months curating a watchlist on another platform, I did not want to pretend that signal did not exist.

That gave me two interaction sources:

- local interactions inside MovieMix
- imported intent from a user's Trakt watchlist

The Trakt integration itself was a very practical engineering problem. I needed OAuth, access tokens, refresh tokens, and deduplication so the same title would not be double counted under both `app` and `trakt` sources.

The refresh logic mattered more than the happy path. OAuth looks easy when it works once. It feels broken when a token expires and the feature silently dies. So the backend now retries once on `401` by attempting a token refresh before giving up.

I also liked what Trakt did for the product experience. It made MovieMix feel less like an empty app waiting for you to train it and more like something that could meet you where you already were.

While I was working on product usefulness, I also added live watch links on title pages. Instead of trying to integrate a complicated provider API, I generated practical outbound links for Netflix, Prime Video, and a Google "watch online" search. It was a small feature, but it made the app feel more actionable. Recommendations are more satisfying when the next step is obvious.

## Similarity Search Was Not Enough

Once the signal layer was stronger, the next question was: what should the actual recommendation pipeline do?

At first, semantic search was carrying too much of the system. It was good at "more like this". It was not enough for a personalized feed.

It also was not the whole answer for direct query handling. Sometimes a user is not asking for fuzzy semantic similarity. Sometimes they are effectively typing the title they want. So alongside semantic retrieval, I also kept a lexical title matching path. If a query closely matched a movie name, the backend could pull in text matches from the catalog instead of forcing everything through embeddings. That made search feel more grounded and reduced the weirdness you sometimes get when an exact title query is treated like a purely semantic question.

So I moved to a hybrid pipeline.

The simplified version looked like this:

1. build a user profile from wishlist items, watched titles, ratings, and interaction weights
2. choose a few seed titles that represent the user's taste
3. generate candidate movies from multiple sources
4. enrich those candidates with ranking features
5. rerank them with XGBoost
6. diversify the final list so it does not feel repetitive
7. attach a reason to each recommendation

That third step was where the system started to feel much more real.

Instead of relying on one retrieval method, I generated candidates from:

- FAISS based semantic search
- globally popular titles
- user user collaborative candidates

That meant the system was no longer asking just "what is similar?" It was asking "what is worth considering for this user at all?"

Then came reranking.

I used XGBoost with a ranking aware objective because raw retrieval scores are bad at making trade offs. Relevance matters, but so do popularity priors, novelty, user profile overlap, and whether an item is too obvious or too repetitive. A reranker can learn those trade offs far better than any single similarity score can.

To train that reranker, I built a derived dataset into `data/xgb_rerank_dataset.csv` from interaction history, wishlist signals, semantic candidates, global popular candidates, and user user collaborative candidates. That mattered because the training data reflected the real candidate pipeline instead of being a disconnected toy dataset.

I also wanted recommendations to explain themselves. So MovieMix attaches `reason` and `reason_code` fields to items, which let the UI say things like "similar to a title you watched", "found by text match", or "popular with similar users". That sounds like polish, but it was also helpful for debugging. If a recommendation looked wrong, I could inspect not just the item but the kind of evidence that produced it.

This is also where I started thinking more like a production recommendation engineer and less like someone building a demo. Public writing from teams like Netflix makes it clear that large scale recommenders are not judged on relevance alone. They also have to balance repetition, diversity, freshness, and serving latency. I was not trying to recreate Netflix's stack one for one, but I was solving a smaller version of the same design problem: do not just return the nearest items, return a list that feels worth showing to a real user.

At that point, the project had crossed an important line. It no longer felt like a search system wearing a recommendation costume. It felt like a ranking system.

## I Needed a Way to Know If It Was Actually Improving

This is where a lot of recommendation projects get fuzzy.

It is very easy to say, "the results look better now". It is much harder to prove it.

So I built an offline evaluation loop.

The first challenge was that I did not have a huge population of real users. To get around that, I used Codex to help me create clustered synthetic users. Instead of generating random junk data, I built taste groups like `action`, `drama`, `comedy`, and `spooky`. Each synthetic user had a believable mix of wishlist rows, watched interactions, ratings, reviews, event logs, and a few holdout titles reserved for evaluation.

That made the testing much more useful than random sampling ever would have.

Then I made the evaluator do something strict: before requesting recommendations, it temporarily hid the holdout titles from the user's visible profile. Only then did it call the personalized route. After the request finished, it restored the hidden rows.

That sounds small, but it is the difference between honest evaluation and accidental cheating.

If the recommender can still see the positives you are evaluating against, your metric can look great while proving very little.

Once that evaluator existed, I could finally measure the system in a way that meant something. In the offline sample run I documented, the main quality numbers looked like this:

- `NDCG@10 = 0.940`
- `Recall@10 = 0.933`
- `HitRate@10 = 1.000`

I also tracked broader metrics like precision, MRR, novelty, coverage, and genre match. I liked that mix because each number told a different story. Precision told me how concentrated the good results were. Recall told me whether held out positives were coming back. NDCG told me whether they were ranked high enough to matter. Novelty and coverage told me whether the system was just recommending the same obvious titles over and over.

One thing I became very opinionated about was cutoff choice.

Yes, the evaluator can calculate `NDCG@100`. But in my setup, each user only had three held out relevant titles. With that kind of setup, `@100` is mathematically valid but not very honest. It starts rewarding "the system eventually found it somewhere in a very long list" instead of "the system ranked it where a user would actually see it."

Take a simple example. If the three held out titles appear at ranks `1`, `20`, and `80`, then:

- `NDCG@10 = 0.469`
- `NDCG@20 = 0.576`
- `NDCG@100 = 0.650`

`@100` looks nicer, but only because it is more forgiving about late hits. For this project, `@10` and `@20` were much better reflections of user experience, because users care about the shortlist, not the hundredth slot.

## I Also Wanted to Measure Product Behavior, Not Just Offline Metrics

Offline ranking metrics were important, but they were not the whole story.

I also added a small A/B testing loop around the recommendation experience. The "For You" flow could assign users to different variants, log the chosen variant with interaction events, and then summarize the results in an experiment dashboard.

That dashboard tracked things like:

- CTR
- wishlist rate
- watch rate
- rating rate
- the current winning variant

I liked this because it connected ranking work back to user behavior. Offline metrics tell you whether the recommender is recovering relevant items. A/B testing tells you whether changes in recommendation strategy or presentation actually change what users do in the product.

It also made ratings more useful outside the model itself. They were not just training signal anymore. They became part of how I measured whether a recommendation variant was leading to stronger engagement.

## Then the Boring Infrastructure Started to Matter

This was the part I underestimated at first.

Once a recommender starts depending on refreshed popularity data, embedding rebuilds, service health, and multiple processes talking to each other, it stops being "just a model". It becomes a system with upkeep.

That is why I added Airflow, Prometheus, Grafana, and Kubernetes.

Airflow handled the recurring jobs that kept the recommender healthy:

- seeding starter titles during development
- rebuilding embeddings on a schedule
- refreshing the `popular_titles` materialized view nightly

That popularity refresh was especially important because popular candidates were part of the recommendation pipeline. If that data went stale, the fallback and broadening behavior would get stale too.

For observability, I exposed Prometheus metrics from both the backend and the recommender, then used Grafana to visualize request behavior and latency. I also added alert rules for simple but useful cases like backend down, recommender down, high 5xx rate, and elevated p99 latency.

In other words, I stopped treating the app as something I personally "knew was working" and started giving it ways to prove that to me.

On the deployment side, I ended up supporting several shapes:

- Docker Compose for fast local development
- Compose plus Caddy for a straightforward hosted VM with HTTPS
- Kubernetes manifests for the multi service stack
- a free demo path using Vercel, Hugging Face Spaces, and Supabase

Kubernetes was the cleanest expression of the full system because by that point MovieMix was clearly not a single process anymore. It was a frontend, an API, a recommender, a scheduler, a database, and a monitoring story.

## Could It Be Fast Enough?

Once the recommendation quality improved, latency became harder to ignore.

The recommender already used FAISS, which is highly optimized. But some of the surrounding score fusion and title matching work was still happening in Python loops.

So I reworked the hot path to be more SIMD friendly in a practical sense:

- cache normalized title metadata
- cache token lookups
- replace Python heavy score fusion with NumPy accumulation
- vectorize title match scoring where it made sense

I did not hand write CPU intrinsics. I just moved more work into array oriented code paths where NumPy and FAISS could do what they are already very good at.

The professional way I would describe that work is this: I made the ranking path more SIMD friendly by restructuring it around vectorized numerical operations, not by claiming some custom low level optimization strategy. That is also the fairest comparison to companies like Netflix. The useful overlap is not "I used Netflix's exact implementation." The overlap is that both systems have to treat latency and list quality as part of the same recommendation problem.

That made a measurable difference.

In the isolated benchmark for the ranking stage, latency dropped from:

- `19.26 ms` to `10.72 ms` on average
- `17.95 ms` to `9.97 ms` at p50
- `23.13 ms` to `13.14 ms` at p95

That is about a `44%` reduction in the ranking path.

The important caveat is that this benchmark isolates the semantic ranking stage. It does not include full HTTP overhead or embedding generation time, so the end to end API improvement will naturally be smaller. But as a measurement of the ranking path itself, it was a clean and encouraging result.

## What I Would Keep If I Built It Again

If I had to compress the whole project into a few lessons, they would be these.

First, similarity search is useful, but it is not the same thing as recommendation.

Second, cold start is not just a model problem. It is also a product problem. Local behavior, imported watchlists, and practical fallbacks matter a lot.

Third, if your evaluation does not hide positives before inference, you probably know less than you think you know.

Fourth, observability and scheduling are not side quests. In recommender systems, stale data and invisible failures quietly turn into quality problems.

And finally, performance work matters more once the rest of the system gets smarter. A better ranker that feels slow is still a worse user experience.

MovieMix improved because I stopped thinking of it as one clever model and started treating it as a connected system: signals, retrieval, reranking, evaluation, operations, and latency.

That is what turned it from a working prototype into something much closer to a real recommendation product.

## What I Would Build Next

There are still a few things I would add if I kept pushing MovieMix further.

The first is real social login through Google sign in instead of relying only on email and password authentication. The current JWT flow works well enough for development and controlled testing, but a production facing movie app should reduce signup friction and make account recovery much easier. Google based sign in would also make it simpler to connect identity across devices and would feel much more natural for casual users.

I would also improve the online evaluation story. The current A/B testing loop is useful, but it is still lightweight. With more real users, I would want stronger experiment design, clearer guardrail metrics, and longer running comparisons across ranking strategies instead of small exploratory tests.

On the recommendation side, I would keep pushing freshness and retrieval quality. That could include richer provider integrations, stronger popularity decay handling, and eventually experimenting with additional ANN indexing strategies if the catalog grew far beyond the current size.

In other words, the project is already doing real recommendation work, but there is still a clear path from "strong engineering prototype" to "more polished production system."
