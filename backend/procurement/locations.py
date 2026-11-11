"""Philippine locations for address pickers (Delivery Location on the Planning form).

The list is the Philippine Standard Geographic Code (PSGC) published by the
Philippine Statistics Authority, served as JSON by https://psgc.gitlab.io/api/
(free, no key). We proxy it rather than calling it from the browser so that:

  * the site's Content-Security-Policy stays closed to third-party hosts,
  * each list is fetched once and cached (it changes a few times a year), and
  * a PSGC outage answers a clear 503, and the form falls back to typing.

    GET /api/locations/regions/
    GET /api/locations/regions/<code>/provinces/
    GET /api/locations/regions/<code>/cities/        regions without provinces (NCR)
    GET /api/locations/provinces/<code>/cities/
    GET /api/locations/cities/<code>/barangays/

Each answers [{code, name}]: regions in PSGC order, the rest by name. Nothing here is stored: the form
writes the chosen names into Project.delivery_location as plain text.
"""
import json
import logging
import re
import urllib.error
import urllib.request

from django.core.cache import cache
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

logger = logging.getLogger(__name__)

PSGC_BASE = "https://psgc.gitlab.io/api"
CACHE_SECONDS = 7 * 24 * 3600
TIMEOUT_SECONDS = 8
CODE = re.compile(r"^\d{9,10}$")

# kind -> (parent path segment, child path segment)
ROUTES = {
    "regions": (None, "regions"),
    "region-provinces": ("regions", "provinces"),
    "region-cities": ("regions", "cities-municipalities"),
    "province-cities": ("provinces", "cities-municipalities"),
    "city-barangays": ("cities-municipalities", "barangays"),
}


class LocationsUnavailable(Exception):
    pass


def fetch_psgc(path):
    """GET one PSGC list. Separate so tests can patch it (they never go online)."""
    req = urllib.request.Request(f"{PSGC_BASE}/{path}/", headers={"Accept": "application/json",
                                                                 "User-Agent": "e-procurement-locations"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:  # noqa: S310 - fixed https host
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        raise LocationsUnavailable(str(exc)) from exc


def location_list(kind, code=None):
    parent, child = ROUTES[kind]
    path = child if parent is None else f"{parent}/{code}/{child}"
    key = f"psgc:{path}"
    cached = cache.get(key)
    if cached is not None:
        return cached
    rows = fetch_psgc(path)
    if not isinstance(rows, list):
        raise LocationsUnavailable("unexpected answer")
    out = []
    for row in rows:
        if not isinstance(row, dict) or not row.get("code") or not row.get("name"):
            continue
        item = {"code": str(row["code"]), "name": str(row["name"])}
        if kind == "regions" and row.get("regionName"):
            item["label"] = f"{row['regionName']} ({row['name']})" if row["regionName"] != row["name"] else row["name"]
        out.append(item)
    # Regions in official PSGC order (Region I, II, ... as people know them);
    # everything below a region alphabetically, as on any address form.
    out.sort(key=(lambda r: r["code"]) if kind == "regions" else (lambda r: r["name"].lower()))
    cache.set(key, out, CACHE_SECONDS)
    return out


class LocationListView(APIView):
    """Signed-in accounts only: the lists are public data, but this keeps the
    proxy from being used by anyone on the internet."""

    permission_classes = [permissions.IsAuthenticated]
    kind = "regions"

    def get(self, request, code=None):
        if code is not None and not CODE.match(code):
            return Response({"detail": "Unknown location code."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            return Response(location_list(self.kind, code))
        except LocationsUnavailable as exc:
            logger.warning("PSGC list %s %s unavailable: %s", self.kind, code, exc)
            return Response({"detail": "The Philippine location list can't be reached right now. "
                                       "Type the delivery location instead.", "code": "locations_unavailable"},
                            status=status.HTTP_503_SERVICE_UNAVAILABLE)
