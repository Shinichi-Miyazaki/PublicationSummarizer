"""テンプレートによる業績整形（リッチ表示 & コピー用テキスト生成）。

- 数値由来フィールドの末尾 ".0" 除去
- 著者の整形（区切り指定）
- 項目ごとの太字／斜体（Markdown）。空フィールドには付けない
- プレースホルダ置換後の空フィールド由来の余分な区切り記号の圧縮
- 年度グルーピング・連番付与（年度見出しは言語対応）
"""

from __future__ import annotations

import math
import re
from pathlib import Path

import pandas as pd
import yaml

from .i18n import tr
from .roster import split_authors

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


def format_authors(authors_raw: str, sep: str) -> str:
    """著者文字列を整形（個々の著者を区切り記号で連結）。"""
    return sep.join(split_authors(authors_raw))


def _style(value: str, key: str, bold: set[str], italic: set[str]) -> str:
    """非空のフィールド値に太字／斜体（Markdown）を付ける。"""
    if not value:
        return value
    b, i = key in bold, key in italic
    if b and i:
        return f"***{value}***"
    if b:
        return f"**{value}**"
    if i:
        return f"*{value}*"
    return value


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
    markdown: bool,
    bold: set[str],
    italic: set[str],
) -> dict:
    fields = {}
    for k, v in rec.items():
        if k in ("date", "fiscal_year", "type", "label", "authors_raw"):
            continue
        fields[k] = "" if v is None else v.strip() if isinstance(v, str) else v
    for nf in spec_numeric:
        if nf in fields:
            fields[nf] = clean_number(fields[nf])
    for k, v in list(fields.items()):
        if isinstance(v, float):
            fields[k] = clean_number(v)
    fields["year"] = _year(rec.get("date"))
    fields["date"] = (
        rec["date"].strftime("%Y/%m/%d")
        if isinstance(rec.get("date"), pd.Timestamp) and not pd.isna(rec.get("date"))
        else ""
    )
    fields["authors"] = format_authors(rec.get("authors_raw", ""), sep)
    # 太字／斜体は Markdown 出力のみ、非空フィールドにだけ付与する。
    if markdown and (bold or italic):
        for k in list(fields.keys()):
            fields[k] = _style(str(fields[k]), k, bold, italic)
    return fields


def render_one(
    rec: dict,
    pattern: str,
    spec_numeric: tuple[str, ...],
    sep: str,
    markdown: bool,
    bold: set[str],
    italic: set[str],
) -> str:
    fields = _build_fields(rec, spec_numeric, sep, markdown, bold, italic)
    raw = pattern.format_map(_SafeDict(fields))
    return _cleanup(raw)


def _sorted_records(df: pd.DataFrame, sort: str) -> pd.DataFrame:
    ascending = sort == "date_asc"
    return df.sort_values("date", ascending=ascending, na_position="last")


def render_records(
    df: pd.DataFrame,
    template: dict,
    numeric_fields: tuple[str, ...] = ("volume", "issue", "pages"),
    bold_fields: set[str] | None = None,
    italic_fields: set[str] | None = None,
    lang: str = "ja",
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
    bold = set(bold_fields or ())
    italic = set(italic_fields or ())

    if df.empty:
        return {"markdown": "_該当なし_", "plain": "", "count": 0}

    df = _sorted_records(df, sort)

    md_lines: list[str] = []
    txt_lines: list[str] = []

    def emit(records: pd.DataFrame):
        for i, (_, rec) in enumerate(records.iterrows(), start=1):
            prefix = f"{i}. " if numbering else ""
            d = rec.to_dict()
            md = render_one(d, pattern, numeric_fields, sep, True, bold, italic)
            tx = render_one(d, pattern, numeric_fields, sep, False, set(), set())
            md_lines.append(f"{prefix}{md}")
            txt_lines.append(f"{prefix}{tx}")

    if group_by == "fiscal_year":
        # 年度が判定できる業績のみを年度別に並べる（不明分を末尾にまとめない）。
        fy = pd.to_numeric(df["fiscal_year"], errors="coerce")
        for year in sorted(fy.dropna().unique(), reverse=(sort != "date_asc")):
            heading = tr("fy_heading", lang).format(y=int(year))
            bracket = f"【{heading}】" if lang == "ja" else f"[{heading}]"
            md_lines.append(f"#### {heading}")
            txt_lines.append(f"\n{bracket}")
            emit(df[fy == year])
    else:
        emit(df)

    return {
        # Markdown は段落区切り（空行）で1件ずつ改行させる。plain は1行ずつ。
        "markdown": "\n\n".join(md_lines).strip(),
        "plain": "\n".join(txt_lines).strip(),
        "count": int(len(df)),
    }
