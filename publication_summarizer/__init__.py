"""研究業績サマライザー: Google Spreadsheet の業績を絞り込み・整形するコアロジック。

Streamlit (app.py) と Colab の双方から再利用できるよう、UI 非依存の純ロジックを置く。
"""

from .schema import SHEET_SPECS, RECORD_TYPES, SheetSpec
from .loader import load_publications, load_workbook_bytes, DEFAULT_SHEET_ID
from .roster import Member, parse_roster, AuthorMatcher
from .filters import by_authors, by_fiscal_year, by_types, by_peer_reviewed, by_scope
from .formatter import load_templates, render_records, clean_number

__all__ = [
    "SHEET_SPECS",
    "RECORD_TYPES",
    "SheetSpec",
    "load_publications",
    "load_workbook_bytes",
    "DEFAULT_SHEET_ID",
    "Member",
    "parse_roster",
    "AuthorMatcher",
    "by_authors",
    "by_fiscal_year",
    "by_types",
    "by_peer_reviewed",
    "by_scope",
    "load_templates",
    "render_records",
    "clean_number",
]
