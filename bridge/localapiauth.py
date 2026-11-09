"""Small, dependency-free gate for LAN requests to the local analysis API."""
import hmac
import ipaddress


def api_proxy_authorized(expected_token, supplied_token, peer_ip):
    """Require the local bridge token from non-loopback peers when configured.

    The PC's own browser may use the loopback bridge without re-entering the
    token. Phone/LAN clients must present the same token used by the MT5 bridge.
    An empty expected token keeps legacy bridge-only mode behavior unchanged.
    """
    expected = str(expected_token or "")
    if not expected:
        return True
    try:
        if ipaddress.ip_address(str(peer_ip or "").split("%", 1)[0]).is_loopback:
            return True
    except ValueError:
        pass
    supplied = str(supplied_token or "")
    return bool(supplied) and hmac.compare_digest(supplied, expected)
