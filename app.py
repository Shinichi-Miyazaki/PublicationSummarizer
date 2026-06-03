"""研究業績サマライザー — Streamlit Web アプリ。

Google Spreadsheet（リンク共有・閲覧可）の業績を、著者・年度・種別で絞り込み、
提出先に応じた書式（科研費ベース・編集可）で整形してコピーできるようにする。
"""

from __future__ import annotations

import streamlit as st

from publication_summarizer import (
    AuthorMatcher,
    DEFAULT_SHEET_ID,
    RECORD_TYPES,
    by_authors,
    by_fiscal_year,
    by_peer_reviewed,
    by_types,
    load_publications,
    load_templates,
    parse_roster,
    render_records,
)
from publication_summarizer.filters import active_members
from publication_summarizer.loader import load_roster_sheet, load_workbook_bytes
from publication_summarizer.schema import SHEET_SPECS

st.set_page_config(page_title="研究業績サマライザー", layout="wide")

NUMERIC_BY_TYPE = {s.rtype: s.numeric_fields for s in SHEET_SPECS}
COLS_BY_TYPE = {s.rtype: list(s.cols.keys()) for s in SHEET_SPECS}

# 書式の差し込み項目（プレースホルダ）の日本語ラベル。
PLACEHOLDER_JA: dict[str, str] = {
    "authors": "著者",
    "title": "タイトル",
    "year": "発行年（西暦）",
    "date": "日付（年月日）",
    "journal": "雑誌名（正式）",
    "journal_abbr": "雑誌名（略称）",
    "volume": "巻",
    "issue": "号",
    "pages": "ページ",
    "doi": "DOI",
    "book_title": "本・雑誌タイトル",
    "review_title": "総説タイトル",
    "chapter": "担当章",
    "editor": "編者",
    "publisher": "出版社",
    "isbn": "ISBN",
    "issn": "ISSN",
    "conference": "学会・イベント名",
    "symposium": "シンポジウム名",
    "invited": "招待（〇/×）",
    "venue": "会場",
    "presentation_type": "発表形態",
    "scope": "国内/国際",
    "awarded_study": "対象研究",
    "organization": "授与機関",
    "media_type": "メディア種別",
    "media_name": "メディア名",
    "link": "リンク",
}


@st.cache_data(ttl=600, show_spinner="スプレッドシートを取得中…")
def fetch_bytes(url_or_id: str) -> bytes:
    return load_workbook_bytes(url_or_id)


@st.cache_data(ttl=600, show_spinner=False)
def load_all(url_or_id: str):
    data = fetch_bytes(url_or_id)
    df = load_publications(data)
    members = parse_roster(load_roster_sheet(data))
    return df, members


def check_password() -> None:
    """限定公開用の簡易パスワードゲート。

    `st.secrets["app_password"]` が設定されている場合のみ認証を要求する。
    未設定（ローカル開発など）のときは素通りする。
    """
    try:
        expected = st.secrets["app_password"]
    except Exception:  # noqa: BLE001  # secrets 未設定 → 制限なし
        return
    if not expected or st.session_state.get("authed"):
        return
    pw = st.text_input("パスワード", type="password", help="研究室で共有されたパスワードを入力してください。")
    if pw == "":
        st.stop()
    if pw == expected:
        st.session_state["authed"] = True
        st.rerun()
    st.error("パスワードが違います。")
    st.stop()


def placeholder_legend(rtype: str) -> str:
    """その種別で使える差し込み項目の凡例（Markdown）を作る。"""
    available = ["authors", "title", "year", "date"] + [
        c for c in COLS_BY_TYPE.get(rtype, []) if c in PLACEHOLDER_JA
    ]
    seen, lines = set(), []
    for key in available:
        if key in seen or key not in PLACEHOLDER_JA:
            continue
        seen.add(key)
        lines.append(f"- `{{{key}}}` … {PLACEHOLDER_JA[key]}")
    return "\n".join(lines)


def main() -> None:
    st.title("📚 研究業績サマライザー")
    check_password()
    st.caption("業績を絞り込み、提出先の書式に整えてコピーできます。各セクションのテキスト枠の右上 📋 でコピー。")

    templates = load_templates()
    preset_names = sorted({p for t in templates.values() for p in t})

    # ── サイドバー：入力とフィルタ ─────────────────────────────
    with st.sidebar:
        st.header("データソース")
        url = st.text_input(
            "スプレッドシート URL または ID",
            value=DEFAULT_SHEET_ID,
            help="「リンクを知っている全員が閲覧可」に設定してください。",
        )
        if st.button("🔄 再読み込み（キャッシュ更新）"):
            st.cache_data.clear()

    try:
        df, members = load_all(url)
    except Exception as exc:  # noqa: BLE001
        st.error(f"読み込みに失敗しました: {exc}\n\nシートの共有設定（閲覧可）と URL を確認してください。")
        st.stop()

    if df.empty:
        st.warning("業績データが見つかりませんでした。シート構成を確認してください。")
        st.stop()

    with st.sidebar:
        st.header("絞り込み")
        type_labels = {RECORD_TYPES[t]: t for t in RECORD_TYPES if t in set(df["type"])}
        selected_labels = st.multiselect(
            "業績種別", list(type_labels), default=list(type_labels)
        )
        selected_types = [type_labels[l] for l in selected_labels]

        threshold = st.slider(
            "著者名の一致のゆるさ", 70, 100, 85,
            help="高いほど厳密（同名でも別人扱いしやすい）、低いほどゆるく拾います。通常は既定のままでOK。",
        )
        matcher = AuthorMatcher(members, threshold=threshold)

        # 業績が1件以上ある人だけを著者リストに出す。
        usable_members = active_members(df, members, matcher)
        member_display = {m.display: m for m in usable_members}
        sel_author_disp = st.multiselect(
            "著者（未選択＝全員）", list(member_display),
            help="研究室メンバーで絞り込み。和名↔ローマ字や表記の揺れを吸収します。",
        )
        sel_members = [member_display[d] for d in sel_author_disp]

        fys = sorted({int(y) for y in df["fiscal_year"].dropna().unique()})
        if fys:
            fy_min, fy_max = st.select_slider(
                "年度（4月始まり）", options=fys, value=(fys[0], fys[-1])
            )
        else:
            fy_min = fy_max = None

        only_pr = st.checkbox("査読ありのみ（論文）", value=False)

        st.header("書式")
        preset = st.radio(
            "提出先（テンプレート）", preset_names,
            index=preset_names.index("科研費") if "科研費" in preset_names else 0,
            help="提出先に合わせて選びます。細かい調整は各セクションの「書式を調整する」から。",
        )

    # ── フィルタ適用 ─────────────────────────────────────────
    filtered = by_types(df, selected_types)
    filtered = by_fiscal_year(filtered, fy_min, fy_max)
    filtered = by_peer_reviewed(filtered, only_pr)
    filtered = by_authors(filtered, sel_members, matcher)

    st.caption(
        f"全 {len(df)} 件中 {len(filtered)} 件を表示"
        + (f"／著者: {', '.join(sel_author_disp)}" if sel_author_disp else "")
    )

    # ── 種別ごとに整形・表示（0件はスキップ）──────────────────
    shown = 0
    for rtype in selected_types:
        sub = filtered[filtered["type"] == rtype]
        if sub.empty:
            continue
        shown += 1
        label = RECORD_TYPES[rtype]
        type_templates = templates.get(rtype, {})
        spec = type_templates.get(preset) or next(
            iter(type_templates.values()), {"pattern": "{authors}. {title}."}
        )

        st.subheader(f"{label}（{len(sub)} 件）")

        with st.expander("✏️ 書式を調整する（任意）"):
            st.markdown(
                "下の枠の **`{ }` で囲まれた語**が、その業績の内容に置き換わります。\n"
                "- 不要な項目は消してOK／順番も自由に変えられます。\n"
                "- 記号（`. ` `;` `()` など）はそのまま文章の区切りになります。\n\n"
                "**この種別で使える項目:**\n" + placeholder_legend(rtype)
            )
            pattern = st.text_area(
                "書式", value=spec.get("pattern", "{authors}. {title}."),
                key=f"pat_{rtype}", height=68, label_visibility="collapsed",
            )
        spec = {**spec, "pattern": pattern}

        result = render_records(
            sub, spec, numeric_fields=NUMERIC_BY_TYPE.get(rtype, ())
        )
        st.code(result["plain"], language=None)

    if shown == 0:
        st.info("条件に合う業績がありません。絞り込みを見直してください。")


if __name__ == "__main__":
    main()
