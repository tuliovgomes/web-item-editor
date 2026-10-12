#!/bin/sh
set -eu

IMAGE_NAME=oteditor-ts:dev
CONTAINER_PORT=4173

docker build -t "$IMAGE_NAME" .

if container_id=$(docker run --detach --rm \
  --publish "127.0.0.1:$CONTAINER_PORT:$CONTAINER_PORT" \
  --env HOST=0.0.0.0 \
  --env "PORT=$CONTAINER_PORT" \
  "$IMAGE_NAME" npm run start 2>/dev/null); then
  host_address="127.0.0.1:$CONTAINER_PORT"
else
  container_id=$(docker run --detach --rm \
    --publish "127.0.0.1::$CONTAINER_PORT" \
    --env HOST=0.0.0.0 \
    --env "PORT=$CONTAINER_PORT" \
    "$IMAGE_NAME" npm run start)
  host_address=$(docker port "$container_id" "$CONTAINER_PORT/tcp")
fi

cleanup() {
  docker stop "$container_id" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

printf 'OTEditor iniciado: http://%s\n' "$host_address"
printf 'Pressione Ctrl+C para encerrar.\n\n'

docker logs --follow "$container_id"
