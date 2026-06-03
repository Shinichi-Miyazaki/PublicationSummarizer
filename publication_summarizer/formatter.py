"""テンプレートによる業績整形（プレビュー & コピー用テキスト生成）。

- 数値由来フィールドの末尾 ".0" 除去
- 著者の整形（区切り指定、自分名の Markdown 太字強調）
- プレースホルダ置換後の空フィールド由来の余分な区切り記号の圧縮
- 年度グルーピング・連番付与
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import pandas as pd
import yaml

from .roster import AuthorMatcher, Member, split_authors

_TEMPLATES_PATH = Path(__file__).with_name("templates.yaml")


def load_templates(path: Path | str = _TEMPLATES_PATH) -> dict:
    """templates.yaml を読み込んで {rtype: {preset: spec}} を返す。"""
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def clean_number(value) -> str:
    """数値由来フィールドの末尾 ".0" を除去（"30.0"->"30"、範囲・文字列は維持）。"""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    s = str(value).strip()
    if re.fullmatch(r"\d+\.0+", s):
        return s.split(".")[0]
    return s


def _year(date) -> str:
    if isinstance(date, pd.Timestamp) and not pd.isna(date):
        return str(date.year)
    return ""


def format_authors(
    authors_raw: str,
    sep: str,
    emphasize: list[Member] | None,
    matcher: AuthorMatcher | None,
    markdown: bool,
) -> str:
    """著者文字列を整形。markdown=True かつ emphasize 指定時は該当著者を太字化。"""
    tokens = split_authors(authors_raw)
    if not tokens:
        return ""
    out: list[str] = []
    for tok in tokens:
        if markdown and emphasize and matcher:
            if any(matcher.matches_member(tok, m) for m in emphasize):
                tok = f"**{tok}**"
        out.append(tok)
    return sep.join(out)


# 空フィールド由来の区切り記号を圧縮するための後処理。
_EMPTY_PARENS = re.compile(r"[（(]\s*[)）]")


def _cleanup(text: str) -> str:
    text = _EMPTY_PARENS.sub("", text)  # 空の () （）
    text = re.sub(r"\s+", " ", text)
    # 連続・孤立した区切り記号を圧縮（例: ";():" → ""、" ;" → ""）
    text = re.sub(r"([;:,])\s*(?=[);:,.])", "", text)
    text = re.sub(r"[;:,]\s*\)", ")", text)
    text = re.sub(r"\(\s*[;:,]\s*", "(", text)
    text = re.sub(r"\s+([);:,.])", r"\1", text)
    text = re.sub(r"([(（])\s+", r"\1", text)
    text = re.sub(r"\.{2,}", ".", text)  # フィールド末尾の "." とパターンの "." の重複
    text = re.sub(r"\.\s+\.", ". ", text)  # ". ." → ". "
    text = re.sub(r"[;:,.\s]+$", "", text)  # 末尾の余分な記号
    text = re.sub(r"^[;:,.\s]+", "", text)  # 先頭の余分な記号
    text = re.sub(r"\s+", " ", text)
    return text.strip()


class _SafeDict(dict):
    def __missing__(self, key):  # 未知/欠損プレースホルダは空文字
        return ""


def _build_fields(
    rec: dict,
    spec_numeric: tuple[str, ...],
    sep: str,
    emphasize: list[Member] | None,
    matcher: AuthorMatcher | None,
    markdown: bool,
) -> dict:
    fields = {}
    for k, v in rec.items():
        if k in ("date", "fiscal_year", "type", "label", "authors_raw"):
            continue
        fields[k] = "" if v is None else str(v).strip() if isinstance(v, str) else v
    for nf in spec_numeric:
        if nf in fields:
            fields[nf] = clean_number(fields[nf])
    # 数値由来でなくとも float が混ざる場合に備え、残りも軽く整形
    for k, v in list(fields.items()):
        if isinstance(v, float):
            fields[k] = clean_number(v)
    fields["year"] = _year(rec.get("date"))
    fields["date"] = (
        rec["date"].strftime("%Y/%m/%d")
        if isinstance(rec.get("date"), pd.Timestamp) and not pd.isna(rec.get("date"))
        else ""
    )
    fields["authors"] = format_authors(
        rec.get("authors_raw", ""), sep, emphasize, matcher, markdown
    )
    return fields


def render_one(
    rec: dict,
    pattern: str,
    spec_numeric: tuple[str, ...],
    sep: str,
    emphasize: list[Member] | None,
    matcher: AuthorMatcher | None,
    markdown: bool,
) -> str:
    fields = _build_fields(rec, spec_numeric, sep, emphasize, matcher, markdown)
    raw = pattern.format_map(_SafeDict(fields))
    return _cleanup(raw)


def _sorted_records(df: pd.DataFrame, sort: str) -> pd.DataFrame:
    ascending = sort == "date_asc"
    return df.sort_values("date", ascending=ascending, na_position="last")


def render_records(
    df: pd.DataFrame,
    template: dict,
    numeric_fields: tuple[str, ...] = ("volume", "issue", "pages"),
    emphasize: list[Member] | None = None,
    matcher: AuthorMatcher | None = None,
) -> dict:
    """1種別の業績群を template に従って整形し、markdown と plain を返す。

    Returns
    -------
    {"markdown": str, "plain": str, "count": int}
    """
    pattern = template.get("pattern", "{authors}. {title}.")
    sep = template.get("author_sep", ", ")
    sort = template.get("sort", "date_desc")
    group_by = template.get("group_by")
    numbering = template.get("numbering", False)

    if df.empty:
        return {"markdown": "_該当なし_", "plain": "", "count": 0}

    df = _sorted_records(df, sort)

    md_lines: list[str] = []
    txt_lines: list[str] = []

    def emit(records: pd.DataFrame):
        for i, (_, rec) in enumerate(records.iterrows(), start=1):
            prefix = f"{i}. " if numbering else ""
            md = render_one(rec.to_dict(), pattern, numeric_fields, sep, emphasize, matcher, True)
            tx = render_one(rec.to_dict(), pattern, numeric_fields, sep, emphasize, matcher, False)
            md_lines.append(f"{prefix}{md}")
            txt_lines.append(f"{prefix}{tx}")

    if group_by == "fiscal_year":
        # 年度が判定できる業績のみを年度別に並べる（不明分を末尾にまとめない）。
        fy = pd.to_numeric(df["fiscal_year"], errors="coerce")
        for year in sorted(fy.dropna().unique(), reverse=(sort != "date_asc")):
            group = df[fy == year]
            md_lines.append(f"\n#### {int(year)}年度")
            txt_lines.append(f"\n【{int(year)}年度】")
            emit(group)
    else:
        emit(df)

    return {
        "markdown": "\n".join(md_lines).strip(),
        "plain": "\n".join(txt_lines).strip(),
        "count": int(len(df)),
    }
