# airflow/dags/refresh_popular_titles.py
from datetime import datetime, timedelta
from airflow import DAG
from airflow.providers.postgres.operators.postgres import PostgresOperator

default_args = {"owner": "moviemix", "retries": 1, "retry_delay": timedelta(minutes=5)}

with DAG(
    dag_id="refresh_popular_titles_nightly",
    default_args=default_args,
    start_date=datetime(2025, 1, 1),
    schedule_interval="0 3 * * *",
    catchup=False,
) as dag:
    refresh = PostgresOperator(
        task_id="refresh_popular",
        postgres_conn_id="moviemix_pg",               # <-- PostgresOperator uses this
        sql="REFRESH MATERIALIZED VIEW popular_titles;"  # remove CONCURRENTLY unless you added a unique index
        # If you insist on CONCURRENTLY, first run:
        # CREATE UNIQUE INDEX IF NOT EXISTS popular_titles_uidx ON popular_titles (title_id);
    )
