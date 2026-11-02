"""ayu_stats: the shared computation primitives of the analysis lane (10.3).

Preloaded in the sandbox. Every function takes pandas Series (indexed by day
where it matters) or DataFrames and returns a plain dict with `n`, so results
are JSON-serialisable and every number the answer uses comes from code.
Statistical defaults only; no medical thresholds live here.
"""

import math

import numpy as np
import pandas as pd
from scipy import stats

__all__ = [
    "align_daily", "coverage", "describe", "trend", "compare_periods", "correlate",
    "lagged_correlate", "anomalies", "threshold_count", "recovery_time", "fdr", "to_daily",
]


def _clean(value):
    """Plain Python numbers; NaN and infinities become None."""
    if isinstance(value, (np.floating, float)):
        v = float(value)
        return None if math.isnan(v) or math.isinf(v) else v
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (pd.Timestamp,)):
        return value.date().isoformat()
    if isinstance(value, dict):
        return {str(k): _clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_clean(v) for v in value]
    return value


def _series(series, name="value"):
    if isinstance(series, pd.DataFrame):
        cols = [c for c in series.columns if c not in ("day", "local_day", "date")]
        if "day" in series.columns or "local_day" in series.columns or "date" in series.columns:
            key = next(c for c in ("day", "local_day", "date") if c in series.columns)
            series = series.set_index(key)[cols[0] if len(cols) == 1 else name]
        else:
            series = series[cols[0]]
    s = pd.Series(series).dropna()
    try:
        s.index = pd.to_datetime(s.index)
    except (ValueError, TypeError):
        pass
    return s.astype(float).sort_index()


def to_daily(df, day_col="day", value_col="value", how="mean"):
    """A DataFrame with a day column -> a float Series indexed by day."""
    frame = df[[day_col, value_col]].dropna()
    frame[day_col] = pd.to_datetime(frame[day_col])
    return frame.groupby(day_col)[value_col].agg(how).astype(float).sort_index()


def align_daily(frames, on="day", how="inner"):
    """Join daily Series/DataFrames (dict name -> data) on the day key."""
    if isinstance(frames, dict):
        parts = []
        for name, f in frames.items():
            s = _series(f)
            s.name = name
            parts.append(s)
    else:
        parts = [_series(f) for f in frames]
    out = pd.concat(parts, axis=1, join=how).sort_index()
    out.index.name = on
    return out


def coverage(series, start, end):
    """Percentage of days in [start, end] with a value."""
    s = _series(series)
    days = pd.date_range(pd.to_datetime(start), pd.to_datetime(end), freq="D")
    have = s.index.normalize().isin(days).sum() if len(s) else 0
    n_days = len(days)
    return {"n": int(have), "days_in_window": n_days, "coverage_pct": _clean(100.0 * have / n_days if n_days else 0.0)}


def describe(series):
    s = _series(series)
    if len(s) == 0:
        return {"n": 0}
    q = s.quantile([0.25, 0.5, 0.75])
    return _clean({
        "n": len(s), "mean": s.mean(), "median": q[0.5], "sd": s.std(ddof=1) if len(s) > 1 else None,
        "min": s.min(), "max": s.max(), "q1": q[0.25], "q3": q[0.75],
        "first_day": s.index.min(), "last_day": s.index.max(),
    })


def trend(series, per="week"):
    """Theil-Sen slope with a 95% interval, plus Kendall tau and its p-value."""
    s = _series(series)
    if len(s) < 3:
        return {"n": len(s), "slope": None}
    days = np.asarray((s.index - s.index.min()).days, dtype=float)
    scale = {"day": 1.0, "week": 7.0, "month": 30.4375, "year": 365.25}[per]
    slope, intercept, lo, hi = stats.theilslopes(s.values, days, 0.95)
    tau, p = stats.kendalltau(days, s.values)
    start_fit = intercept
    end_fit = intercept + slope * days.max()
    return _clean({
        "n": len(s), "per": per, "slope": slope * scale, "slope_low": lo * scale, "slope_high": hi * scale,
        "kendall_tau": tau, "p_value": p, "fitted_start": start_fit, "fitted_end": end_fit,
        "change_over_window": end_fit - start_fit, "first_day": s.index.min(), "last_day": s.index.max(),
    })


def compare_periods(a, b):
    """Medians, difference (b - a), Mann-Whitney U p-value, rank-biserial effect size."""
    sa, sb = _series(a), _series(b)
    if len(sa) == 0 or len(sb) == 0:
        return {"n": len(sa) + len(sb), "n_a": len(sa), "n_b": len(sb)}
    u, p = stats.mannwhitneyu(sa.values, sb.values, alternative="two-sided")
    effect = 1.0 - 2.0 * u / (len(sa) * len(sb))
    return _clean({
        "n": len(sa) + len(sb), "n_a": len(sa), "n_b": len(sb), "median_a": sa.median(), "median_b": sb.median(),
        "mean_a": sa.mean(), "mean_b": sb.mean(), "difference": sb.median() - sa.median(),
        "p_value": p, "rank_biserial": -effect,
    })


def correlate(x, y, method="spearman"):
    joined = align_daily({"x": x, "y": y}).dropna()
    n = len(joined)
    if n < 3:
        return {"n": n, "coefficient": None}
    fn = {"spearman": stats.spearmanr, "pearson": stats.pearsonr, "kendall": stats.kendalltau}[method]
    r, p = fn(joined["x"], joined["y"])
    return _clean({"n": n, "method": method, "coefficient": r, "p_value": p})


def lagged_correlate(x, y, lags=range(-3, 4), method="spearman"):
    """Correlation of x(day) with y(day + lag) for each lag; positive lag = y later."""
    sx, sy = _series(x), _series(y)
    out = []
    for lag in lags:
        shifted = sy.copy()
        shifted.index = shifted.index - pd.Timedelta(days=lag)
        r = correlate(sx, shifted, method)
        out.append({"lag": lag, "n": r["n"], "coefficient": r.get("coefficient"), "p_value": r.get("p_value")})
    valid = [o for o in out if o["coefficient"] is not None]
    best = max(valid, key=lambda o: abs(o["coefficient"])) if valid else None
    return _clean({"n": max([o["n"] for o in out] or [0]), "by_lag": out, "strongest_lag": best})


def anomalies(series, baseline_days=28, z=2.0):
    """Episodes outside a rolling personal baseline (median and MAD of the
    previous `baseline_days` days), with start and end days."""
    s = _series(series).asfreq("D")
    med = s.rolling(baseline_days, min_periods=max(7, baseline_days // 2)).median().shift(1)
    mad = (s - med).abs().rolling(baseline_days, min_periods=max(7, baseline_days // 2)).median().shift(1) * 1.4826
    score = (s - med) / mad.replace(0, np.nan)
    flagged = score.abs() > z
    episodes, start = [], None
    for day, flag in flagged.items():
        if flag and start is None:
            start = day
        if not flag and start is not None:
            seg = score[start:day - pd.Timedelta(days=1)]
            episodes.append({"start": start, "end": day - pd.Timedelta(days=1), "days": len(seg), "peak_z": seg.abs().max(),
                             "direction": "above" if seg.mean() > 0 else "below"})
            start = None
    if start is not None:
        seg = score[start:]
        episodes.append({"start": start, "end": score.index.max(), "days": len(seg), "peak_z": seg.abs().max(),
                         "direction": "above" if seg.mean() > 0 else "below"})
    return _clean({"n": int(s.notna().sum()), "baseline_days": baseline_days, "z": z,
                   "days_scored": int(score.notna().sum()), "episodes": episodes})


def threshold_count(series, op, value):
    s = _series(series)
    ops = {">": s > value, ">=": s >= value, "<": s < value, "<=": s <= value, "==": s == value, "!=": s != value}
    mask = ops[op]
    return _clean({"n": len(s), "count": int(mask.sum()), "pct": 100.0 * mask.sum() / len(s) if len(s) else None,
                   "days": [d for d in s.index[mask]]})


def recovery_time(series, event_day, baseline_days=28):
    """Days after `event_day` until the value is back inside the baseline band
    (median +/- 1.4826 * MAD of the `baseline_days` before the event)."""
    s = _series(series)
    event = pd.to_datetime(event_day)
    base = s[(s.index < event) & (s.index >= event - pd.Timedelta(days=baseline_days))]
    if len(base) < 7:
        return {"n": len(base), "days_to_recover": None, "reason": "not enough baseline"}
    med = base.median()
    band = 1.4826 * (base - med).abs().median()
    after = s[s.index > event]
    for day, v in after.items():
        if abs(v - med) <= band:
            return _clean({"n": len(base) + len(after), "baseline_median": med, "band": band,
                           "recovered_on": day, "days_to_recover": (day - event).days})
    return _clean({"n": len(base) + len(after), "baseline_median": med, "band": band, "recovered_on": None, "days_to_recover": None})


def fdr(p_values):
    """Benjamini-Hochberg adjusted p-values (same order)."""
    p = np.asarray([1.0 if v is None else v for v in p_values], dtype=float)
    n = len(p)
    if n == 0:
        return {"n": 0, "adjusted": []}
    order = np.argsort(p)
    ranked = p[order] * n / (np.arange(n) + 1)
    adjusted = np.minimum.accumulate(ranked[::-1])[::-1]
    out = np.empty(n)
    out[order] = np.minimum(adjusted, 1.0)
    return _clean({"n": n, "adjusted": out.tolist()})
