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
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pandas as pd
import yaml

from .i18n import tr
from .roster import split_authors
from .schema import BILINGUAL_FIELDS

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


@dataclass(frozen=True)
class AuthorStyle:
    """著者整形の設定（プリセット／UI から構築し、YAML・UI・テストが共有する）。"""

    sep: str = ", "  # 著者間の区切り
    max_authors: int = 0  # 表示上限（0 = 全員）
    etal: str = ""  # 省略語（空なら言語既定: ja「ほか」/ en「et al.」）
    etal_count: bool = False  # True で「ほかN名」形式（残数を明示。ja 向け）
    keep_highlighted: bool = True  # 強調著者は省略対象外（上限超でも必ず残す）
    emphasis: str = "bold"  # 強調著者の装飾: "bold" | "none"


_ELLIPSIS = "…"  # 中間省略（強調著者を残した際の欠落箇所）を表す記号


def author_style_from_template(t: dict) -> AuthorStyle:
    """テンプレート／UI 上書き dict から AuthorStyle を構築（欠損は既定値）。"""
    return AuthorStyle(
        sep=t.get("author_sep", ", "),
        max_authors=int(t.get("author_max", 0) or 0),
        etal=str(t.get("author_etal", "") or ""),
        etal_count=bool(t.get("author_etal_count", False)),
        keep_highlighted=bool(t.get("author_keep_highlighted", True)),
        emphasis=str(t.get("author_emphasis", "bold") or "bold"),
    )


def _etal_marker(style: AuthorStyle, lang: str, remaining: int) -> str:
    """末尾省略語を返す。etal_count かつ ja のときのみ「ほかN名」と残数を付す。"""
    base = style.etal or ("ほか" if lang == "ja" else "et al.")
    if style.etal_count and lang == "ja":
        return f"{base}{remaining}名"
    return base


def render_authors(
    authors_raw: str,
    style: AuthorStyle,
    lang: str = "ja",
    highlight: Callable[[str], bool] | None = None,
    markdown: bool = False,
) -> str:
    """著者文字列を整形（人数省略・自己強調・言語別省略語に対応）。

    - 上限超のときは先頭から `max_authors` 名を表示。`keep_highlighted` の場合、
      範囲外でも強調著者は必ず残す（順序保持）。
    - 表示著者間に欠落があれば中略記号 `…`、最後の表示著者の後ろに著者が残る場合のみ
      末尾に省略語（et al. / ほか）。→ 強調著者が末尾なら省略語は付かない。
    - `markdown` かつ emphasis="bold" のとき、強調著者を **太字** にする。
    """
    tokens = split_authors(authors_raw)
    if not tokens:
        return ""
    n = len(tokens)
    is_hl = [bool(highlight and highlight(t)) for t in tokens]

    if style.max_authors and n > style.max_authors:
        shown_idx = [
            i for i in range(n)
            if i < style.max_authors or (style.keep_highlighted and is_hl[i])
        ]
    else:
        shown_idx = list(range(n))

    def render_tok(i: int) -> str:
        if markdown and style.emphasis == "bold" and is_hl[i]:
            return f"**{tokens[i]}**"
        return tokens[i]

    parts: list[str] = []
    prev: int | None = None
    for i in shown_idx:
        if prev is not None and i > prev + 1:
            parts.append(_ELLIPSIS)  # 中間の欠落
        parts.append(render_tok(i))
        prev = i

    if shown_idx[-1] < n - 1:  # 末尾にまだ著者が残る → 省略語
        parts.append(_etal_marker(style, lang, n - len(shown_idx)))

    return style.sep.join(parts)


def has_highlighted_author(authors_raw: str, highlight: Callable[[str], bool] | None) -> bool:
    """著者中に強調対象が含まれるか（二重太字回避の判定に使う）。"""
    if not highlight:
        return False
    return any(highlight(t) for t in split_authors(authors_raw))


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


def _resolve_lang(fields: dict, lang: str) -> None:
    """二ヶ国語 base を表示言語へ解決して fields[base] に入れる。

    en: F_en があれば F_en、無ければ F_ja。 ja: 逆。片方のみなら有る方を使う。
    """
    for base in BILINGUAL_FIELDS:
        ja_v = fields.get(base + "_ja", "")
        en_v = fields.get(base + "_en", "")
        ja = "" if ja_v is None else str(ja_v).strip()
        en = "" if en_v is None else str(en_v).strip()
        fields[base] = (en or ja) if lang == "en" else (ja or en)


def _build_fields(
    rec: dict,
    spec_numeric: tuple[str, ...],
    style: AuthorStyle,
    markdown: bool,
    bold: set[str],
    italic: set[str],
    lang: str = "ja",
    highlight: Callable[[str], bool] | None = None,
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
    _resolve_lang(fields, lang)  # {title} 等の base を表示言語へ
    fields["year"] = _year(rec.get("date"))
    fields["date"] = (
        rec["date"].strftime("%Y/%m/%d")
        if isinstance(rec.get("date"), pd.Timestamp) and not pd.isna(rec.get("date"))
        else ""
    )
    authors_raw = rec.get("authors_raw", "")
    fields["authors"] = render_authors(authors_raw, style, lang, highlight, markdown)
    # 二重太字回避: 著者強調(bold)が実際に効くなら {authors} のフィールド単位 bold は外す
    # （内側 **member** と外側 **…** の入れ子破綻を防ぐ。italic は両立するため許可）。
    if markdown and style.emphasis == "bold" and has_highlighted_author(authors_raw, highlight):
        bold = bold - {"authors"}
    # 太字／斜体は Markdown 出力のみ、非空フィールドにだけ付与する。
    if markdown and (bold or italic):
        for k in list(fields.keys()):
            fields[k] = _style(str(fields[k]), k, bold, italic)
    return fields


def render_one(
    rec: dict,
    pattern: str,
    spec_numeric: tuple[str, ...],
    style: AuthorStyle,
    markdown: bool,
    bold: set[str],
    italic: set[str],
    lang: str = "ja",
    highlight: Callable[[str], bool] | None = None,
) -> str:
    fields = _build_fields(rec, spec_numeric, style, markdown, bold, italic, lang, highlight)
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
    highlight: Callable[[str], bool] | None = None,
) -> dict:
    """1種別の業績群を template に従って整形し、markdown と plain を返す。

    highlight: 著者トークン -> 強調対象か を返す述語（選択メンバー判定。app 側が生成）。

    Returns
    -------
    {"markdown": str, "plain": str, "count": int}
    """
    pattern = template.get("pattern", "{authors}. {title}.")
    style = author_style_from_template(template)
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
            md = render_one(d, pattern, numeric_fields, style, True, bold, italic, lang, highlight)
            tx = render_one(d, pattern, numeric_fields, style, False, set(), set(), lang, highlight)
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
