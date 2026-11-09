"""Fail-closed, broker-sourced Exness open-position limit helpers."""

MAX_MT5_OPEN_POSITIONS = 10


def validate_open_positions(positions, requested_limit=None):
    """Return a decision from a fresh MT5 positions_get() result.

    None means MT5 could not verify the account state and must block. The
    requested limit can lower the cap, but can never raise it above the
    existing 10-position maximum.
    """
    if positions is None:
        return {"ok": False, "count": None, "limit": None,
                "reason": "MT5 open positions could not be verified; refusing the order."}
    try:
        count = len(positions)
    except (TypeError, ValueError):
        return {"ok": False, "count": None, "limit": None,
                "reason": "MT5 returned an invalid open-positions result; refusing the order."}
    try:
        requested = MAX_MT5_OPEN_POSITIONS if requested_limit is None else int(requested_limit)
    except (TypeError, ValueError, OverflowError):
        return {"ok": False, "count": count, "limit": None,
                "reason": "Open-trades limit could not be verified; refusing the order."}
    if requested < 1:
        return {"ok": False, "count": count, "limit": None,
                "reason": "Open-trades limit is invalid; refusing the order."}
    limit = min(requested, MAX_MT5_OPEN_POSITIONS)
    if count >= limit:
        return {"ok": False, "count": count, "limit": limit,
                "reason": "MT5 currently reports %d/%d open positions; no order was sent." % (count, limit)}
    return {"ok": True, "count": count, "limit": limit, "reason": "MT5 reports %d/%d open positions." % (count, limit)}
