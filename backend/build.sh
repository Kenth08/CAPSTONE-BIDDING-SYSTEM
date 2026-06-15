#!/usr/bin/env bash
# Render build step for the Django backend.
# Exit on any error so a failed migration/collectstatic fails the deploy.
set -o errexit

pip install -r requirements.txt

# Gather static files (Django admin assets) for WhiteNoise to serve.
python manage.py collectstatic --no-input

# Apply database migrations.
python manage.py migrate
