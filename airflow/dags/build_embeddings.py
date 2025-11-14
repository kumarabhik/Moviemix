from datetime import datetime, timedelta
from airflow import DAG
from airflow.providers.http.operators.http import SimpleHttpOperator
from airflow.utils.dates import days_ago

# In Airflow UI > Connections, create:
# Conn Id: recommender_http
# Conn Type: HTTP
# Host: http://recommender:8001

default_args = {
    "owner": "moviemix",
    "retries": 1,
    "retry_delay": timedelta(minutes=5),
}

with DAG(
    dag_id="build_embeddings_nightly",
    default_args=default_args,
    start_date=days_ago(1),
    schedule_interval="0 2 * * *",  # 2am daily
    catchup=False,
    tags=["moviemix"],
) as dag:

    build = SimpleHttpOperator(
        task_id="call_recommender_build",
        http_conn_id="recommender_http",
        endpoint="/admin/build_embeddings",
        method="POST",
        headers={"Content-Type": "application/json"},
        data="{}",
        log_response=True,
    )

    build
