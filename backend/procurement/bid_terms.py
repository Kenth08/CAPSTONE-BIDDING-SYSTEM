"""Delivery timeline and warranty period as controlled choices.

Each procurement lists the choices its specifications allow (Staff pick them
when preparing it): delivery in calendar days, warranty in months. Bidders then
choose from that list instead of typing free text, and the server only accepts a
choice the project offers.

Stored twice on the bid, on purpose:
  * the number (Bid.delivery_days, Bid.warranty_months) for sorting, filtering
    and comparing bids;
  * the readable label in the existing text fields (delivery_timeline,
    warranty_period). delivery_timeline is inside the anchored bid payload
    (payload_v2.bid_payload), so it keeps holding a plain string like before.

A project with no choices (every project made before this change) keeps the
free-text fields, so existing projects and bids are unaffected.
"""
import json

# Menus Staff choose from. Nothing is offered to bidders unless Staff select it.
DELIVERY_DAY_PRESETS = [7, 15, 30, 45, 60, 90, 120, 180, 270, 365]
WARRANTY_MONTH_PRESETS = [3, 6, 12, 18, 24, 36, 60]
MAX_DELIVERY_DAYS = 365
MAX_WARRANTY_MONTHS = 120


def delivery_label(days):
    return f"{days} calendar day{'' if days == 1 else 's'}"


def warranty_label(months):
    if months % 12 == 0:
        years = months // 12
        return f"{years} year{'' if years == 1 else 's'}"
    return f"{months} month{'' if months == 1 else 's'}"


def parse_options(raw, *, maximum, label):
    """A project's list of allowed values from request data (a JSON list, or a
    JSON string of one, as multipart forms send it). Returns a sorted list of
    unique whole numbers, or raises ValueError with a message for the user."""
    if raw in (None, "", []):
        return []
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            raise ValueError(f"The {label} choices are not a valid list.") from None
    if not isinstance(raw, list):
        raise ValueError(f"The {label} choices are not a valid list.")
    out = set()
    for item in raw:
        try:
            value = int(item)
        except (TypeError, ValueError):
            raise ValueError(f"Each {label} choice must be a whole number.") from None
        if isinstance(item, float) and item != value:
            raise ValueError(f"Each {label} choice must be a whole number.")
        if not 1 <= value <= maximum:
            raise ValueError(f"Each {label} choice must be between 1 and {maximum}.")
        out.add(value)
    return sorted(out)


def pick(raw, allowed, *, label):
    """The bidder's choice, checked against the project's allowed list.
    Returns the whole number, or raises ValueError."""
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        raise ValueError(f"Choose a {label} from the list.") from None
    if value not in allowed:
        raise ValueError(f"Choose a {label} offered for this procurement.")
    return value
