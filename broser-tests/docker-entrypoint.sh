#!/bin/sh

set -e

# build .env
# envsubst < .env.sample >.env

# execute the CMD
exec "$@"
