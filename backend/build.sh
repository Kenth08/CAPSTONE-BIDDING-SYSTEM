#!/usr/bin/env bash
# Render build step for the Django backend.
# Exit on any error so a failed migration/collectstatic fails the deploy.
set -o errexit

pip install -r requirements.txt

# Gather static files (Django admin assets) for WhiteNoise to serve.
python manage.py collectstatic --no-input

# Apply database migrations.
python manage.py migrate

# Confirm server-signed blockchain anchors against Sepolia: saves the block
# number of each one that succeeded and clears any that failed on-chain, so a
# record can never keep showing "On-chain" when it isn't. Best-effort — a
# network or chain problem must never fail a deploy.
python manage.py confirm_anchors --apply || echo "confirm_anchors skipped"
