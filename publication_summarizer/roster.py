"""メンバー名簿のパースと著者名寄せ（決定的 + rapidfuzz のハイブリッド）。

著者表記は不統一（"Shinichi Miyazaki" / "Miyazaki S" / "宮崎 慎一" / 注記混入 / 末尾ピリオド）。
名簿（Input confirmation）の和名↔ローマ字を正典に、決定的照合で大半を吸収し、
未マッチ分を rapidfuzz の類似度で救済する。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

import pandas as pd
from rapidfuzz import fuzz

# 名簿セル例: "宮崎 慎一  MIYAZAKI, Shinichi"
_ROSTER_RE = re.compile(r"^(?P<ja>.+?)\s{2,}(?P<last>[A-Za-z'’\-]+),\s*(?P<first>.+)$")

# 著者トークンから除去する注記（Co-first author 等）。
_ANNOTATION_RE = re.compile(r"\(\s*\*?\s*(co-first|co-corresponding|corresponding|equal)[^)]*\)", re.I)


def normalize(text: str) -> str:
    """比較用に正規化（Unicode 正規化・小文字化・記号除去・空白圧縮）。"""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text))
    text = _ANNOTATION_RE.sub(" ", text)
    text = text.replace(".", " ").replace(",", " ")
    text = re.sub(r"[*’'\-]", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip().lower()


@dataclass(frozen=True)
class Member:
    """名簿上の1メンバー。"""

    ja: str  # 和名（例: "宮崎 慎一"）
    last: str  # 英姓（例: "Miyazaki"）
    first: str  # 英名（例: "Shinichi"）
    role: str = ""

    @property
    def display(self) -> str:
        return f"{self.ja} / {self.last} {self.first[:1]}."

    @property
    def aliases(self) -> set[str]:
        """決定的照合に使う正規化済みエイリアス集合。"""
        f, l, fi = self.first, self.last, self.first[:1]
        ja_nospace = self.ja.replace(" ", "").replace("　", "")
        forms = [
            f"{f} {l}",  # Shinichi Miyazaki
            f"{l} {f}",  # Miyazaki Shinichi
            f"{l} {fi}",  # Miyazaki S
            f"{fi} {l}",  # S Miyazaki
            self.ja,  # 宮崎 慎一
            ja_nospace,  # 宮崎慎一
        ]
        return {normalize(x) for x in forms if x.strip()}


def parse_roster(raw: pd.DataFrame) -> list[Member]:
    """名簿シート（生 DataFrame）から Member リストを抽出。

    B列 = 役職, C列 = "和名  LAST, First"。見出し行は正規表現非マッチで自然に除外。
    """
    members: list[Member] = []
    seen: set[tuple[str, str]] = set()
    for _, row in raw.iterrows():
        role = row.iloc[1] if len(row) > 1 else ""
        name = row.iloc[2] if len(row) > 2 else ""
        if not isinstance(name, str):
            continue
        m = _ROSTER_RE.match(name.strip())
        if not m:
            continue
        last = m.group("last").strip().title()
        first = m.group("first").strip().title()
        key = (last.lower(), first.lower())
        if key in seen:
            continue
        seen.add(key)
        members.append(
            Member(
                ja=m.group("ja").strip(),
                last=last,
                first=first,
                role=str(role).strip() if isinstance(role, str) else "",
            )
        )
    return members


def split_authors(authors_raw: str) -> list[str]:
    """著者セルを個々の著者文字列に分割（カンマ区切り、注記除去）。"""
    if not authors_raw:
        return []
    text = _ANNOTATION_RE.sub("", str(authors_raw))
    parts = [p.strip(" .;") for p in text.split(",")]
    return [p for p in parts if p]


class AuthorMatcher:
    """選択メンバーが業績の著者に含まれるかを判定する。

    第1段: 決定的エイリアス完全一致。
    第2段: rapidfuzz による類似度（姓一致を AND 条件にして誤マッチ抑制）。
    """

    def __init__(self, members: list[Member], threshold: int = 85):
        self.members = members
        self.threshold = threshold
        self._alias_index: dict[str, set[str]] = {m.display: m.aliases for m in members}

    def matches_member(self, author_token: str, member: Member) -> bool:
        norm = normalize(author_token)
        if not norm:
            return False
        # 第1段: 決定的
        if norm in member.aliases:
            return True
        # 第2段: あいまい一致（姓を含む or 高類似のときのみ）
        last = member.last.lower()
        if last and last in norm.split():
            return True
        score = max(fuzz.token_sort_ratio(norm, a) for a in member.aliases)
        return score >= self.threshold

    def record_has_member(self, authors_raw: str, member: Member) -> bool:
        tokens = split_authors(authors_raw)
        return any(self.matches_member(t, member) for t in tokens)

    def record_has_any(self, authors_raw: str, members: list[Member]) -> bool:
        tokens = split_authors(authors_raw)
        return any(
            self.matches_member(t, m) for t in tokens for m in members
        )


# --- 将来拡張用フック（v1 未実装）------------------------------------------------
def resolve_with_llm(unique_author_tokens: list[str]) -> dict[str, str]:
    """ユニーク著者文字列を LLM で名寄せクラスタリングする想定の拡張点（未実装）。

    クエリ毎ではなくユニーク著者に対し1回・結果キャッシュ前提で呼ぶ設計余地を残す。
    必要になれば Claude API（prompt caching）等で実装する。
    """
    raise NotImplementedError("LLM 名寄せは v1 のスコープ外です。")
