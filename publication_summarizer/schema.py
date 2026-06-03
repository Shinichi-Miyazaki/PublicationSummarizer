"""シート → 列インデックス（位置）マッピングと業績種別の定義。

対象スプレッドシートは列名が日英2言語・改行入り・列ズレありで不安定なため、
列名ではなく **列インデックス（0始まり）** で各論理フィールドを取り出す。

各業績シートの共通レイアウト（0始まりの行番号）:
    R0 = シートタイトル/注意書き
    R1 = 列名（参考。実際の抽出には使わない）
    R2 = 記入例の注意書き
    R3 = Example 行（B列 = "例"）
    R4 以降 = 実データ（A列 No = 1, 2, 3 ...）
"""

from __future__ import annotations

from dataclasses import dataclass, field


# 業績種別（内部キー → 画面表示ラベル）
RECORD_TYPES: dict[str, str] = {
    "paper": "原著論文・英文総説",
    "book": "著書・和文総説",
    "presentation": "発表・講演",
    "award": "受賞",
    "outreach": "アウトリーチ",
    "publicity": "広報・パブリシティ",
}


@dataclass(frozen=True)
class SheetSpec:
    """1業績シートの抽出仕様。"""

    keyword: str  # シート名に含まれる識別キーワード（大文字小文字無視で部分一致）
    rtype: str  # RECORD_TYPES のキー
    cols: dict[str, int]  # 論理フィールド名 -> 列インデックス
    people_field: str  # 著者フィルタ対象の人物列（論理名）
    title_field: str  # 主タイトル列（論理名）
    date_field: str = "date"  # 日付列（論理名）
    # 整形時に末尾 ".0" を除去すべき数値由来フィールド
    numeric_fields: tuple[str, ...] = ("volume", "issue", "pages")

    @property
    def label(self) -> str:
        return RECORD_TYPES[self.rtype]


# 列インデックスは実データ（pub.xlsx）で確認済み。
SHEET_SPECS: list[SheetSpec] = [
    SheetSpec(
        keyword="Original Papers",
        rtype="paper",
        cols={
            "no": 0,
            "date": 2,
            "category": 3,
            "peer_reviewed": 4,
            "authors": 5,
            "title": 6,
            "journal": 7,
            "journal_abbr": 8,
            "volume": 9,
            "issue": 10,
            "pages": 11,
            "doi": 12,
        },
        people_field="authors",
        title_field="title",
    ),
    SheetSpec(
        keyword="Books",  # "著書、和文総説　Books, Japanese Reviews"
        rtype="book",
        cols={
            "no": 0,
            "date": 2,
            "international": 3,
            "peer_reviewed": 4,
            "authors": 5,
            "review_title": 6,
            "book_title": 7,
            "chapter": 8,
            "editor": 9,
            "volume": 10,
            "issue": 11,
            "pages": 12,
            "publisher": 13,
            "doi": 14,
            "issn": 15,
            "isbn": 16,
        },
        people_field="authors",
        title_field="book_title",
    ),
    SheetSpec(
        keyword="presentations",  # "発表・講演 presentations"
        rtype="presentation",
        cols={
            "no": 0,
            "date": 2,
            "scope": 3,  # Domestic / International
            "title": 4,
            "authors": 5,
            "conference": 6,
            "symposium": 7,
            "invited": 8,
            "venue": 9,
            "presentation_type": 12,  # Oral / Poster
        },
        people_field="authors",
        title_field="title",
    ),
    SheetSpec(
        keyword="Awards",  # "受賞　Awards"
        rtype="award",
        cols={
            "no": 0,
            "date": 2,
            "scope": 3,
            "authors": 4,  # 受賞者名
            "title": 5,  # 賞タイトル
            "awarded_study": 6,
            "organization": 7,
        },
        people_field="authors",
        title_field="title",
        numeric_fields=(),
    ),
    SheetSpec(
        keyword="Outreach",  # "アウトリーチ Outreach"
        rtype="outreach",
        cols={
            "no": 0,
            "date": 2,
            "scope": 3,
            "authors": 4,  # 実施者
            "title": 5,  # 活動概要
            "venue": 6,
        },
        people_field="authors",
        title_field="title",
        numeric_fields=(),
    ),
    SheetSpec(
        keyword="Publicity",  # "報道パブリシティ　Publicity"
        rtype="publicity",
        cols={
            "no": 0,
            "date": 2,
            "media_type": 3,
            "media_name": 4,
            "authors": 5,  # 掲載人物
            "title": 6,  # 掲載概要
            "link": 7,
        },
        people_field="authors",
        title_field="title",
        numeric_fields=(),
    ),
]


# シート名キーワード（業績シートとして扱う）。これ以外（名簿等）は無視。
ROSTER_KEYWORD = "Input confirmation"


def spec_for_sheet(sheet_name: str) -> SheetSpec | None:
    """シート名から該当する SheetSpec を返す（なければ None）。"""
    lower = sheet_name.lower()
    for spec in SHEET_SPECS:
        if spec.keyword.lower() in lower:
            return spec
    return None
