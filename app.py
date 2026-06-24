"""研究業績サマライザー — Streamlit Web アプリ。

Google Spreadsheet（リンク共有・閲覧可）の業績を、著者・年度・種別で絞り込み、
提出先に応じた書式（科研費ベース・編集可）で整形してコピーできるようにする。
UI は日英切り替え対応。太字・斜体の指定も可能。
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
    by_scope,
    by_types,
    load_publications,
    load_templates,
    parse_roster,
    render_records,
)
from publication_summarizer.filters import active_members
from publication_summarizer.i18n import (
    LANGUAGES,
    PLACEHOLDER_LABELS,
    ph_label,
    preset_label,
    rt_label,
    tr,
)
from publication_summarizer.loader import load_roster_sheet, load_workbook_bytes
from publication_summarizer.schema import SHEET_SPECS, display_fields

st.set_page_config(page_title="研究業績サマライザー / Publication Summarizer", layout="wide")

NUMERIC_BY_TYPE = {s.rtype: s.numeric_fields for s in SHEET_SPECS}
# 書式凡例・装飾対象は base 名に集約（二ヶ国語ペア _ja/_en は {title} 等として解決）。
COLS_BY_TYPE = {s.rtype: display_fields(s.rtype) for s in SHEET_SPECS}


@st.cache_data(ttl=600, show_spinner="スプレッドシートを取得中…")
def fetch_bytes(url_or_id: str) -> bytes:
    return load_workbook_bytes(url_or_id)


@st.cache_data(ttl=600, show_spinner=False)
def load_all(url_or_id: str):
    data = fetch_bytes(url_or_id)
    df = load_publications(data)
    members = parse_roster(load_roster_sheet(data))
    return df, members


@st.cache_data(ttl=600, show_spinner=False)
def usable_members(url_or_id: str, threshold: int):
    """業績に1件以上登場するメンバーのみを返す（rapidfuzz 照合をキャッシュ）。

    リラン毎の再計算を避けるため (url, threshold) でメモ化する。
    """
    df, members = load_all(url_or_id)
    matcher = AuthorMatcher(members, threshold=threshold)
    return active_members(df, members, matcher)


def check_password(lang: str) -> None:
    """限定公開用の簡易パスワードゲート（secrets 未設定なら素通り）。"""
    try:
        expected = st.secrets["app_password"]
    except Exception:  # noqa: BLE001
        return
    if not expected or st.session_state.get("authed"):
        return
    pw = st.text_input(tr("pw_label", lang), type="password", help=tr("pw_help", lang))
    if pw == "":
        st.stop()
    if pw == expected:
        st.session_state["authed"] = True
        st.rerun()
    st.error(tr("pw_error", lang))
    st.stop()


def style_fields_for(rtype: str) -> list[str]:
    """その種別で太字／斜体に指定できる項目（論理キー）の一覧。"""
    keys = ["authors", "title", "year", "date"] + [
        c for c in COLS_BY_TYPE.get(rtype, []) if c in PLACEHOLDER_LABELS
    ]
    seen, out = set(), []
    for k in keys:
        if k not in seen and k in PLACEHOLDER_LABELS:
            seen.add(k)
            out.append(k)
    return out


def make_initials_resolver(matcher: AuthorMatcher, fmt: str):
    """著者トークン→「姓＋名イニシャル」を返す述語を作る（名簿照合・結果をメモ化）。

    照合できない外部共著者は None を返し、formatter 側で元表記のまま残す。
    fmt: "last_first"=「Yamada T」/ "first_last"=「T. Yamada」。
    """
    cache: dict[str, str | None] = {}

    def resolve(token: str) -> str | None:
        if token not in cache:
            m = matcher.resolve_member(token)
            if m is None:
                cache[token] = None
            else:
                fi = m.first[:1]
                if not fi:
                    cache[token] = m.last
                else:
                    cache[token] = f"{fi}. {m.last}" if fmt == "first_last" else f"{m.last} {fi}"
        return cache[token]

    return resolve


def placeholder_legend(rtype: str, lang: str) -> str:
    """その種別で使える差し込み項目の凡例（Markdown）。"""
    return "\n".join(
        f"- `{{{k}}}` … {ph_label(k, lang)}" for k in style_fields_for(rtype)
    )


def main() -> None:
    # ── 言語選択（最初に決める）──────────────────────────────
    with st.sidebar:
        lang_choice = st.radio(
            "言語 / Language", list(LANGUAGES), horizontal=True, key="lang"
        )
    lang = LANGUAGES[lang_choice]

    st.title(tr("app_title", lang))
    check_password(lang)
    st.caption(tr("intro", lang))

    templates = load_templates()
    preset_keys = sorted({p for t in templates.values() for p in t})

    # ── サイドバー：データソース ─────────────────────────────
    with st.sidebar:
        st.header(tr("sb_datasource", lang))
        url = st.text_input(tr("url_label", lang), value=DEFAULT_SHEET_ID, help=tr("url_help", lang))
        if st.button(tr("reload_btn", lang)):
            # データ取得のキャッシュのみ無効化（全 cache_data を消さない）。
            load_all.clear()
            fetch_bytes.clear()
            usable_members.clear()

    try:
        df, members = load_all(url)
    except Exception as exc:  # noqa: BLE001
        st.error(tr("load_error", lang).format(exc=exc))
        st.stop()

    if df.empty:
        st.warning(tr("no_data_warn", lang))
        st.stop()

    # ── サイドバー：絞り込み ─────────────────────────────────
    with st.sidebar:
        st.header(tr("sb_filter", lang))
        type_labels = {rt_label(t, lang): t for t in RECORD_TYPES if t in set(df["type"])}
        selected_labels = st.multiselect(tr("type_label", lang), list(type_labels), default=list(type_labels))
        selected_types = [type_labels[l] for l in selected_labels]

        threshold = st.slider(tr("author_loose_label", lang), 70, 100, 85, help=tr("author_loose_help", lang))
        matcher = AuthorMatcher(members, threshold=threshold)

        member_display = {m.display: m for m in usable_members(url, threshold)}
        sel_author_disp = st.multiselect(tr("author_label", lang), list(member_display), help=tr("author_help", lang))
        sel_members = [member_display[d] for d in sel_author_disp]

        fys = sorted({int(y) for y in df["fiscal_year"].dropna().unique()})
        if fys:
            fy_min, fy_max = st.select_slider(tr("fy_label", lang), options=fys, value=(fys[0], fys[-1]))
        else:
            fy_min = fy_max = None

        only_pr = st.checkbox(tr("peer_label", lang), value=False)

        scope_options = {tr("scope_all", lang): "", tr("scope_domestic", lang): "国内", tr("scope_intl", lang): "国際"}
        scope_choice = st.radio(tr("scope_label", lang), list(scope_options), horizontal=True)
        scope = scope_options[scope_choice]

        st.header(tr("sb_format", lang))
        preset_disp = [preset_label(k, lang) for k in preset_keys]
        default_idx = preset_keys.index("科研費") if "科研費" in preset_keys else 0
        preset_choice = st.radio(tr("preset_label", lang), preset_disp, index=default_idx, help=tr("preset_help", lang))
        preset = preset_keys[preset_disp.index(preset_choice)]

    # ── フィルタ適用 ─────────────────────────────────────────
    filtered = by_types(df, selected_types)
    filtered = by_fiscal_year(filtered, fy_min, fy_max)
    filtered = by_peer_reviewed(filtered, only_pr)
    filtered = by_scope(filtered, scope)
    filtered = by_authors(filtered, sel_members, matcher)

    caption = tr("count_caption", lang).format(total=len(df), shown=len(filtered))
    if sel_author_disp:
        caption += tr("count_author_suffix", lang).format(names=", ".join(sel_author_disp))
    st.caption(caption)

    # 選択メンバーを出力中で強調するための述語（未選択なら強調なし）。
    highlight = (
        (lambda tok: any(matcher.matches_member(tok, m) for m in sel_members))
        if sel_members else None
    )

    # ── 種別ごとに整形・表示（0件はスキップ）──────────────────
    shown = 0
    all_md: list[str] = []  # 全種別まとめてコピー用（リッチ）
    all_plain: list[str] = []  # 同上（プレーン）
    for rtype in selected_types:
        sub = filtered[filtered["type"] == rtype]
        if sub.empty:
            continue
        shown += 1
        label = rt_label(rtype, lang)
        type_templates = templates.get(rtype, {})
        spec = type_templates.get(preset) or next(
            iter(type_templates.values()), {"pattern": "{authors}. {title}."}
        )

        st.subheader(tr("subheader", lang).format(label=label, n=len(sub)))

        style_keys = style_fields_for(rtype)
        disp_to_key = {ph_label(k, lang): k for k in style_keys}
        with st.expander(tr("expander_format", lang)):
            st.markdown(tr("legend_intro", lang) + placeholder_legend(rtype, lang))
            pattern = st.text_area(
                tr("format_textarea", lang), value=spec.get("pattern", "{authors}. {title}."),
                key=f"pat_{rtype}", height=68, label_visibility="collapsed",
            )
            st.caption(tr("style_hint", lang))
            c1, c2 = st.columns(2)
            with c1:
                bold_disp = st.multiselect(tr("style_bold", lang), list(disp_to_key), key=f"bold_{rtype}")
            with c2:
                italic_disp = st.multiselect(tr("style_italic", lang), list(disp_to_key), key=f"italic_{rtype}")

            st.markdown(f"**{tr('author_section', lang)}**")
            a1, a2 = st.columns(2)
            with a1:
                author_max = st.number_input(
                    tr("author_max_label", lang), min_value=0, step=1,
                    value=int(spec.get("author_max", 0) or 0),
                    key=f"amax_{rtype}", help=tr("author_max_help", lang),
                )
                author_etal = st.text_input(
                    tr("author_etal_label", lang), value=str(spec.get("author_etal", "") or ""),
                    key=f"aetal_{rtype}", help=tr("author_etal_help", lang),
                )
            with a2:
                author_etal_count = st.checkbox(
                    tr("author_etal_count_label", lang),
                    value=bool(spec.get("author_etal_count", False)), key=f"acount_{rtype}",
                )
                author_keep_hl = st.checkbox(
                    tr("author_keep_hl_label", lang),
                    value=bool(spec.get("author_keep_highlighted", True)), key=f"akeep_{rtype}",
                )
                author_bold = st.checkbox(
                    tr("author_emphasis_label", lang),
                    value=spec.get("author_emphasis", "bold") != "none",
                    key=f"aemph_{rtype}", help=tr("author_emphasis_help", lang),
                )

            author_initials = st.checkbox(
                tr("author_initials_label", lang),
                value=bool(spec.get("author_initials", False)),
                key=f"ainit_{rtype}", help=tr("author_initials_help", lang),
            )
            initials_fmt = str(spec.get("author_initials_format", "last_first") or "last_first")
            if author_initials:
                fmt_options = {
                    tr("author_initials_fmt_last", lang): "last_first",
                    tr("author_initials_fmt_first", lang): "first_last",
                }
                fmt_choice = st.radio(
                    tr("author_initials_fmt_label", lang), list(fmt_options),
                    key=f"ainitfmt_{rtype}", horizontal=True,
                )
                initials_fmt = fmt_options[fmt_choice]
        bold_fields = {disp_to_key[d] for d in bold_disp}
        italic_fields = {disp_to_key[d] for d in italic_disp}
        spec = {
            **spec, "pattern": pattern,
            "author_max": int(author_max), "author_etal": author_etal,
            "author_etal_count": author_etal_count, "author_keep_highlighted": author_keep_hl,
            "author_emphasis": "bold" if author_bold else "none",
            "author_initials": author_initials, "author_initials_format": initials_fmt,
        }

        # イニシャル整形は名簿照合で「姓＋名イニシャル」を作る述語を渡す（OFF なら None）。
        name_resolver = make_initials_resolver(matcher, initials_fmt) if author_initials else None

        result = render_records(
            sub, spec,
            numeric_fields=NUMERIC_BY_TYPE.get(rtype, ()),
            bold_fields=bold_fields, italic_fields=italic_fields, lang=lang,
            highlight=highlight, name_resolver=name_resolver,
        )
        st.caption(tr("copy_hint", lang))
        st.markdown(result["markdown"])
        with st.expander(tr("plain_expander", lang)):
            st.code(result["plain"], language=None)

        if result["markdown"]:
            all_md.append(f"#### {label}\n\n{result['markdown']}")
        if result["plain"]:
            all_plain.append(f"【{label}】\n{result['plain']}")

    if shown == 0:
        st.info(tr("no_match_info", lang))
    elif shown > 1:
        # 複数種別が表示されているときだけ、まとめてコピーを提供する。
        st.divider()
        st.subheader(tr("copy_all_header", lang))
        st.caption(tr("copy_all_hint", lang))
        st.markdown("\n\n".join(all_md))
        with st.expander(tr("plain_expander", lang)):
            st.code("\n\n".join(all_plain), language=None)


if __name__ == "__main__":
    main()
