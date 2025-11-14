# MOVIEMIX-DAG seed v1
from datetime import datetime
from airflow import DAG
from airflow.utils.dates import days_ago

# ✅ Correct import for Airflow 2.x (the only version we care about)
try:
    from airflow.providers.postgres.operators.postgres import PostgresOperator
except ImportError as e:
    raise ImportError(
        "PostgresOperator not found. Install it with:\n"
        "pip install apache-airflow-providers-postgres"
    ) from e


default_args = {"owner": "airflow", "depends_on_past": False}

with DAG(
    dag_id="moviemix_seed_titles",
    description="Seed a few titles into moviemix.titles",
    start_date=days_ago(1),
    schedule=None,  # trigger manually
    catchup=False,
    default_args=default_args,
    tags=["moviemix", "seed"],
) as dag:

    seed = PostgresOperator(
        task_id="seed_titles",
        postgres_conn_id="moviemix_pg",
        sql="""
        INSERT INTO titles (imdb_id, trakt_id, trakt_slug, name, year, plot, genres, poster_url, popularity)
        VALUES
        ('tt1375666', 1, 'inception-2010', 'Inception', 2010,
            'A thief who steals corporate secrets through dream-sharing tech.',
            ARRAY['Sci-Fi','Thriller'], NULL, 9.8),
        ('tt0816692', 2, 'interstellar-2014', 'Interstellar', 2014,
            'A team travels through a wormhole to ensure humanity''s survival.',
            ARRAY['Sci-Fi','Drama'], NULL, 9.5),
        ('tt4154796', 3, 'avengers-endgame-2019', 'Avengers: Endgame', 2019,
            'After the devastating events of Infinity War...',
            ARRAY['Action','Adventure'], NULL, 9.0)
        ON CONFLICT (imdb_id) DO NOTHING;
        """
    )
