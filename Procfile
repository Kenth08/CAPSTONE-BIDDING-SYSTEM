web: cd backend && python manage.py collectstatic --noinput && gunicorn config.wsgi:application --bind 0.0.0.0:$PORT --worker-class gthread --threads 3
