"""シート → 論理フィールド定義と業績種別の定義。

対象スプレッドシート（Canonical）は **1 行目＝安定したヘッダ名**（論理フィールド名）を持つ。
loader はヘッダ名で各フィールドを取り出すため、ここでは各業績シートが持つ
**論理フィールドの並び**（`fields`）と、フィルタ・整形に使う代表フィールドを定義する。

各業績シートの共通レイアウト:
    R0 = ヘッダ行（メタ列 record_id/status/submitter/source/created_at ＋ 各 fields）
    R1 以降 = 実データ（1 行 = 1 業績）
"""

from __future__ import annotations

from dataclasses import dataclass


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
    fields: tuple[str, ...]  # このシートが持つ論理フィールド名（＝ヘッダ名）の並び
    people_field: str  # 著者フィルタ対象の人物列（論理名）
    title_field: str  # 主タイトル列（論理名）
    date_field: str = "date"  # 日付列（論理名）
    # 整形時に末尾 ".0" を除去すべき数値由来フィールド
    numeric_fields: tuple[str, ...] = ("volume", "issue", "pages")

    @property
    def label(self) -> str:
        return RECORD_TYPES[self.rtype]


# 論理フィールドは Canonical のヘッダ名と一致する。
SHEET_SPECS: list[SheetSpec] = [
    SheetSpec(
        keyword="Original Papers",
        rtype="paper",
        fields=(
            "date", "category", "peer_reviewed", "authors", "title",
            "journal", "journal_abbr", "volume", "issue", "pages", "doi",
        ),
        people_field="authors",
        title_field="title",
    ),
    SheetSpec(
        keyword="Books",  # "著書、和文総説　Books, Japanese Reviews"
        rtype="book",
        fields=(
            "date", "international", "peer_reviewed", "authors", "review_title",
            "book_title", "chapter", "editor", "volume", "issue", "pages",
            "publisher", "doi", "issn", "isbn",
        ),
        people_field="authors",
        title_field="book_title",
    ),
    SheetSpec(
        keyword="presentations",  # "発表・講演 presentations"
        rtype="presentation",
        fields=(
            "date", "scope", "title", "authors", "conference",
            "symposium", "invited", "venue", "presentation_type",
        ),
        people_field="authors",
        title_field="title",
    ),
    SheetSpec(
        keyword="Awards",  # "受賞　Awards"
        rtype="award",
        fields=("date", "scope", "authors", "title", "awarded_study", "organization"),
        people_field="authors",
        title_field="title",
        numeric_fields=(),
    ),
    SheetSpec(
        keyword="Outreach",  # "アウトリーチ Outreach"
        rtype="outreach",
        fields=("date", "scope", "authors", "title", "venue"),
        people_field="authors",
        title_field="title",
        numeric_fields=(),
    ),
    SheetSpec(
        keyword="Publicity",  # "報道パブリシティ　Publicity"
        rtype="publicity",
        fields=("date", "media_type", "media_name", "authors", "title", "link"),
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
