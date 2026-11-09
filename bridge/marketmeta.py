"""Conservative MT5 catalogue classification from broker-provided metadata."""


def market_category(path="", description="", name=""):
    text = (str(path or "") + " " + str(description or "") + " " + str(name or "")).lower()
    if any(k in text for k in ("etf", "exchange traded fund")):
        return "etfs"
    if any(k in text for k in ("bond", "treasury", "fixed income")):
        return "bonds"
    if any(k in text for k in ("energy", "energies", "crude", "brent", "wti", "oil", "natural gas", "heating oil", "gasoline")):
        return "energies"
    if any(k in text for k in ("metal", "gold", "silver", "platinum", "palladium", "copper")):
        return "metals"
    if any(k in text for k in ("forex", "currency", "foreign exchange")):
        return "forex"
    if any(k in text for k in ("index", "indices")):
        return "indices"
    if any(k in text for k in ("stock", "shares", "equities", "equity")):
        return "stocks"
    if any(k in text for k in ("crypto", "bitcoin", "ethereum")):
        return "crypto"
    if any(k in text for k in ("commodity", "commodities")):
        return "commodities"
    return "other"
