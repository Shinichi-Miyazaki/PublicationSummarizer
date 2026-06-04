"""Canonical Spreadsheet（リンク共有・閲覧可）から業績を取得し正規化する。

認証不要。`/export?format=xlsx` で全シートを1リクエスト取得し、各シートを
schema.py の論理フィールド仕様に従って **ヘッダ名** で共通スキーマの DataFrame に正規化する。
"""

from __future__ import annotations

import io
import re
from typing import Union

import pandas as pd
import requests

from .schema import ROSTER_KEYWORD, SheetSpec, spec_for_sheet

# 既定の対象スプレッドシート ID（研究室業績シート / Canonical）。
DEFAULT_SHEET_ID = "1_7b_-6EsRNr6tW1naDj8QJ5M0espE5Wv"

_EXPORT_URL = "https://docs.google.com/spreadsheets/d/{sheet_id}/export?format=xlsx"
_ID_RE = re.compile(r"/spreadsheets/d/([a-zA-Z0-9_-]+)")

# 共通スキーマの先頭メタ列（残りは種別ごとの論理フィールドが続く）。
META_COLUMNS = ["type", "label", "record_id", "date", "fiscal_year", "authors_raw"]

# status 列でのフィルタ: この値の行のみ採用する（列が無ければ全件採用）。
APPROVED_STATUS = "確認済"


def extract_sheet_id(url_or_id: str) -> str:
    """共有 URL もしくは ID 文字列からスプレッドシート ID を取り出す。"""
    url_or_id = url_or_id.strip()
    m = _ID_RE.search(url_or_id)
    if m:
        return m.group(1)
    return url_or_id


def load_workbook_bytes(url_or_id: str = DEFAULT_SHEET_ID, timeout: int = 30) -> bytes:
    """スプレッドシートを xlsx バイト列として取得する。"""
    sheet_id = extract_sheet_id(url_or_id)
    resp = requests.get(_EXPORT_URL.format(sheet_id=sheet_id), timeout=timeout)
    resp.raise_for_status()
    return resp.content


def _fiscal_year(dt: pd.Timestamp) -> "pd.NA | int":
    """年度（4月始まり）を返す。1〜3月は前年度。"""
    if pd.isna(dt):
        return pd.NA
    return dt.year if dt.month >= 4 else dt.year - 1


# 文字列中の最初の日付（yyyy/m[/d] または yyyy-m[-d]）。範囲表記対策。
_DATE_RE = re.compile(r"\d{4}[/-]\d{1,2}(?:[/-]\d{1,2})?")


def _parse_date(value) -> pd.Timestamp:
    """混在する日付表現を頑健に解析。

    datetime / "2025/4/21" / "2020/03/23" / "yyyy/mm" に加え、
    範囲表記（"2025/7/24-2025/7/26" / "2021/4~2023/3"）は先頭の日付を採用する。
    """
    if value is None or (isinstance(value, float) and pd.isna(value)):
        return pd.NaT
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return pd.NaT
        m = _DATE_RE.search(value)
        if m:
            value = m.group(0)
    return pd.to_datetime(value, errors="coerce")


def _value(row: pd.Series, name: str) -> str:
    """指定ヘッダ名の値を返す（欠損は空文字、文字列は trim）。"""
    if name not in row.index:
        return ""
    val = row[name]
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return ""
    if isinstance(val, str):
        return val.strip()
    return val  # 数値・Timestamp はそのまま（後段で整形）


def _normalize_sheet(raw: pd.DataFrame, spec: SheetSpec) -> list[dict]:
    """1シートの生 DataFrame（ヘッダ付き）を共通スキーマの dict 行リストに変換。"""
    raw = raw.rename(columns=lambda c: str(c).strip())
    has_status = "status" in raw.columns
    records: list[dict] = []

    for _, row in raw.iterrows():
        # 品質ゲート: status 列があれば「確認済」のみ採用。
        if has_status and str(_value(row, "status")).strip() != APPROVED_STATUS:
            continue

        rec: dict = {"type": spec.rtype, "label": spec.label}
        for logical in spec.fields:
            rec[logical] = _value(row, logical)
        rec["record_id"] = _value(row, "record_id")

        # 著者・主タイトル・日付がいずれも空の行（空テンプレ）は捨てる。
        people = str(rec.get(spec.people_field, "")).strip()
        main_title = str(rec.get(spec.title_field, "")).strip()
        date_cell = str(rec.get(spec.date_field, "")).strip()
        if not (people or main_title or date_cell):
            continue

        date = _parse_date(rec.get(spec.date_field))
        rec["date"] = date
        rec["fiscal_year"] = _fiscal_year(date)
        rec["authors_raw"] = rec.get(spec.people_field, "")
        if not str(rec.get("title", "")).strip():
            rec["title"] = rec.get(spec.title_field, "")
        records.append(rec)
    return records


def load_publications(source: Union[str, bytes] = DEFAULT_SHEET_ID) -> pd.DataFrame:
    """業績シートを読み込み、全種別を結合した共通スキーマ DataFrame を返す。

    Parameters
    ----------
    source : str | bytes
        共有 URL / ID（取得）か、取得済み xlsx バイト列（テスト・キャッシュ用）。
    """
    data = source if isinstance(source, (bytes, bytearray)) else load_workbook_bytes(source)
    sheets = pd.read_excel(io.BytesIO(data), sheet_name=None, header=0)

    all_records: list[dict] = []
    for name, raw in sheets.items():
        if ROSTER_KEYWORD.lower() in name.lower():
            continue
        spec = spec_for_sheet(name)
        if spec is None:
            continue
        all_records.extend(_normalize_sheet(raw, spec))

    if not all_records:
        return pd.DataFrame(columns=META_COLUMNS)

    df = pd.DataFrame(all_records)
    # メタ列を先頭に並べ替え（存在する列のみ）。
    ordered = [c for c in META_COLUMNS if c in df.columns]
    rest = [c for c in df.columns if c not in ordered]
    return df[ordered + rest]


def load_roster_sheet(source: Union[str, bytes] = DEFAULT_SHEET_ID) -> pd.DataFrame:
    """メンバー名簿シート（Input confirmation）を生のまま返す。

    名簿は parse_roster が列インデックス（B列=役職, C列=氏名）で読むため header=None で取得する。
    """
    data = source if isinstance(source, (bytes, bytearray)) else load_workbook_bytes(source)
    sheets = pd.read_excel(io.BytesIO(data), sheet_name=None, header=None)
    for name, raw in sheets.items():
        if ROSTER_KEYWORD.lower() in name.lower():
            return raw
    return pd.DataFrame()
