"""業績 DataFrame に対する絞り込み（著者 / 年度 / 種別 / 査読）。

いずれも副作用なしの純関数で、フィルタ後の新しい DataFrame を返す。
"""

from __future__ import annotations

import pandas as pd

from .roster import AuthorMatcher, Member, split_authors


def active_members(
    df: pd.DataFrame, members: list[Member], matcher: AuthorMatcher
) -> list[Member]:
    """業績に1件以上登場するメンバーのみを返す（全0件のメンバーを除外）。

    全著者トークンを一意化してから照合し、無駄な再計算を避ける。
    """
    tokens: set[str] = set()
    for raw in df["authors_raw"].dropna():
        for tok in split_authors(str(raw)):
            tokens.add(tok)
    return [m for m in members if any(matcher.matches_member(t, m) for t in tokens)]


def by_types(df: pd.DataFrame, types: list[str] | None) -> pd.DataFrame:
    """業績種別（schema.RECORD_TYPES のキー）で絞り込む。None/空は全件。"""
    if not types:
        return df
    return df[df["type"].isin(types)]


def by_fiscal_year(
    df: pd.DataFrame, fy_min: int | None = None, fy_max: int | None = None
) -> pd.DataFrame:
    """年度（fiscal_year）範囲で絞り込む。両端 None なら制限なし。

    fiscal_year が欠損（日付不明）の行は範囲指定時に除外される。
    """
    if fy_min is None and fy_max is None:
        return df
    fy = pd.to_numeric(df["fiscal_year"], errors="coerce")
    mask = fy.notna()
    if fy_min is not None:
        mask &= fy >= fy_min
    if fy_max is not None:
        mask &= fy <= fy_max
    return df[mask]


def by_authors(
    df: pd.DataFrame, members: list[Member], matcher: AuthorMatcher
) -> pd.DataFrame:
    """選択メンバーの **いずれか** が著者に含まれる業績に絞り込む。空なら全件。"""
    if not members:
        return df
    mask = df["authors_raw"].apply(lambda raw: matcher.record_has_any(raw, members))
    return df[mask]


# 査読ありと見なす表記（フォーム「査読あり」・旧データ「〇」・英語表記などを許容）。
_PEER_YES = {"査読あり", "〇", "○", "あり", "有", "yes", "true", "peer-reviewed", "peerreviewed", "1"}


def _is_peer_reviewed(value) -> bool:
    s = str(value).strip().lower().replace(" ", "")
    return s in {v.lower() for v in _PEER_YES}


def by_peer_reviewed(df: pd.DataFrame, only_peer_reviewed: bool) -> pd.DataFrame:
    """査読ありのみに絞り込む。表記ゆれ（査読あり/〇/yes 等）を吸収する。"""
    if not only_peer_reviewed or "peer_reviewed" not in df.columns:
        return df
    return df[df["peer_reviewed"].apply(_is_peer_reviewed)]
