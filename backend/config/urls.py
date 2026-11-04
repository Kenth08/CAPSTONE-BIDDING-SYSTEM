"""URL configuration for config project."""
from django.conf import settings
from django.conf.urls.static import static
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path('api/auth/', include('accounts.urls')),
    path('api/', include('procurement.urls')),
]

# The Django admin is mounted only at the configured, non-default ADMIN_URL
# (see settings.py); with ADMIN_URL unset in production there is no admin site
# at all. Its login is protected by the same lockout as the API and, for
# accounts that need it, by MFA (accounts/admin_site.py).
if settings.ADMIN_URL:
    urlpatterns.insert(0, path(settings.ADMIN_URL, admin.site.urls))

if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
