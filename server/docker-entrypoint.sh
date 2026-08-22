#!/bin/sh
set -eu

mkdir -p /config

if [ ! -s /config/config.json ]; then
    cp /defaults/config.json /config/config.json
fi

chown -R node:node /config

exec gosu node "$@"
