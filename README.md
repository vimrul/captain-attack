# Captain Attack

Captain Attack is a Dockerized distributed cURL load-testing app. It generates random uppercase secret names such as `IP`, `VP`, and `BBBB`, creates safe random values from 12–40 characters, and sends requests in this exact shape:

```bash
curl -s -X POST -d 'IP=generated_value&PASSWORD=generated_value&PORT=generated_value&USERNAME=generated_value' URL
```

## Run with Docker Compose

Start the API, Postgres, and one worker:

```bash
docker compose up --build
```

Open <http://localhost:4173>.

Scale to 100 workers:

```bash
docker compose up --build --scale worker=100
```

The UI's Docker worker setting is the maximum number of workers allowed to claim a run lease. The `--scale worker=N` value controls how many worker containers are actually running. Each container defaults to 16 concurrent request loops, configurable with `WORKER_CONCURRENCY` in `docker-compose.yml`.

The Compose Postgres service is configured with a 512-connection budget and each worker uses a small three-connection database pool, so the default setup is sized for 100+ worker containers without opening a 40-connection pool per worker.

## Scale design

- Secret/value pairs are generated on demand inside workers; the app does not pre-stage millions of rows.
- Counters are batched before being written to Postgres.
- Postgres leases prevent more than the configured worker count from joining a run.
- Only the configured number of successful cURL samples is retained, keeping the database bounded.
- Values use `A-Z`, `a-z`, `0-9`, `_`, and `-`, so the exact single-quoted cURL format stays valid.

## Configuration limits

- Run time: 1 second to 24 hours
- Secret/value pairs per request: 1 to 1,000
- Secret names: 2 to 20 uppercase characters
- Values: 12 to 40 characters
- Docker workers: 1 to 10,000
- Per-worker concurrency: 1 to 256

Only test systems you own or have permission to exercise. The browser UI sends the configured URL to the API, and the workers send POST requests to that target.
