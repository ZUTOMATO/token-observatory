#!/usr/bin/env bash
# Token Observatory launcher
cd "$(dirname "$0")"
PORT="${PORT:-3180}" exec node server.js
