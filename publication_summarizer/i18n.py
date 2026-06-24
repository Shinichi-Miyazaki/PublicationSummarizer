"""UI 文言の日英対訳（i18n）。

各エントリは (日本語, English) のタプル。`tr(key, lang)` で取り出す。
業績データそのもの（著者名・タイトル等）は翻訳しない。
"""

from __future__ import annotations

# 言語セレクタの表示名 -> 内部コード
LANGUAGES: dict[str, str] = {"日本語": "ja", "English": "en"}


STRINGS: dict[str, tuple[str, str]] = {
    "app_title": ("📚 研究業績サマライザー", "📚 Publication Summarizer"),
    "intro": (
        "業績を絞り込み、提出先の書式に整えます。太字・斜体も指定でき、Word 等に貼ると反映されます。",
        "Filter publications and format them for your target document. "
        "Bold/italic are supported and preserved when pasted into Word, etc.",
    ),
    "lang_label": ("言語 / Language", "言語 / Language"),
    "pw_label": ("パスワード", "Password"),
    "pw_help": (
        "研究室で共有されたパスワードを入力してください。",
        "Enter the password shared within your lab.",
    ),
    "pw_error": ("パスワードが違います。", "Incorrect password."),
    "sb_datasource": ("データソース", "Data source"),
    "url_label": ("スプレッドシート URL または ID", "Spreadsheet URL or ID"),
    "url_help": (
        "「リンクを知っている全員が閲覧可」に設定してください。",
        "Set the sheet to 'Anyone with the link can view'.",
    ),
    "reload_btn": ("🔄 再読み込み（キャッシュ更新）", "🔄 Reload (refresh cache)"),
    "load_error": (
        "読み込みに失敗しました: {exc}\n\nシートの共有設定（閲覧可）と URL を確認してください。",
        "Failed to load: {exc}\n\nCheck the sheet's sharing setting (view access) and the URL.",
    ),
    "no_data_warn": (
        "業績データが見つかりませんでした。シート構成を確認してください。",
        "No publication data found. Please check the sheet structure.",
    ),
    "sb_filter": ("絞り込み", "Filters"),
    "type_label": ("業績種別", "Record types"),
    "author_loose_label": ("著者名の一致のゆるさ", "Author name match looseness"),
    "author_loose_help": (
        "高いほど厳密（同名でも別人扱いしやすい）、低いほどゆるく拾います。通常は既定のままでOK。",
        "Higher = stricter; lower = looser matching. The default is usually fine.",
    ),
    "author_label": ("著者（未選択＝全員）", "Author (none = everyone)"),
    "author_help": (
        "研究室メンバーで絞り込み。和名↔ローマ字や表記の揺れを吸収します。",
        "Filter by lab member. Handles Japanese↔Roman names and spelling variants.",
    ),
    "fy_label": ("年度（4月始まり）", "Fiscal year (Apr–Mar)"),
    "peer_label": ("査読ありのみ（論文）", "Peer-reviewed only (papers)"),
    "scope_label": ("国内/国際（発表・受賞・アウトリーチ）", "Domestic/Intl (talks, awards, outreach)"),
    "scope_all": ("すべて", "All"),
    "scope_domestic": ("国内", "Domestic"),
    "scope_intl": ("国際", "International"),
    "sb_format": ("書式", "Format"),
    "preset_label": ("提出先（テンプレート）", "Target (template)"),
    "preset_help": (
        "提出先に合わせて選びます。細かい調整は各セクションの「書式を調整する」から。",
        "Pick by target document. Fine-tune via 'Adjust format' in each section.",
    ),
    "count_caption": ("全 {total} 件中 {shown} 件を表示", "Showing {shown} of {total}"),
    "count_author_suffix": ("／著者: {names}", " / Authors: {names}"),
    "subheader": ("{label}（{n} 件）", "{label} ({n})"),
    "expander_format": ("✏️ 書式を調整する（任意）", "✏️ Adjust format (optional)"),
    "legend_intro": (
        "下の枠の **`{ }` で囲まれた語**が、その業績の内容に置き換わります。\n"
        "- 不要な項目は消してOK／順番も自由に変えられます。\n"
        "- 記号（`. ` `;` `()` など）はそのまま文章の区切りになります。\n\n"
        "**この種別で使える項目:**\n",
        "The **words in `{ }`** below are replaced with each record's content.\n"
        "- Delete any you don't need; reorder freely.\n"
        "- Punctuation (`. ` `;` `()` …) is kept as separators.\n\n"
        "**Available items for this type:**\n",
    ),
    "format_textarea": ("書式", "Format"),
    "style_hint": (
        "**太字・斜体**は、下のメニューで項目を選ぶと付きます（記号を打つ必要はありません）。",
        "**Bold/italic**: just pick items in the menus below (no need to type symbols).",
    ),
    "style_bold": ("太字にする項目", "Bold items"),
    "style_italic": ("斜体にする項目", "Italic items"),
    "author_section": ("👥 著者の表示", "👥 Author display"),
    "author_max_label": ("表示する著者数（0＝全員）", "Authors to show (0 = all)"),
    "author_max_help": (
        "上限を超える著者は省略語でまとめます。0 なら全員を表示します。",
        "Authors beyond the limit are summarized with an et-al marker. 0 shows everyone.",
    ),
    "author_etal_label": ("省略語（空＝自動）", "Et-al marker (blank = auto)"),
    "author_etal_help": (
        "空欄なら言語に応じて「ほか」（日本語）/「et al.」（英語）になります。",
        "Blank auto-selects 「ほか」(Japanese) / 「et al.」(English).",
    ),
    "author_etal_count_label": ("「ほかN名」と人数を出す（日本語）", "Show remaining count as 「ほかN名」 (Japanese)"),
    "author_keep_hl_label": (
        "選択した著者は省略せず必ず表示",
        "Always keep the selected author(s) visible",
    ),
    "author_emphasis_label": ("選択した著者を太字にする", "Bold the selected author(s)"),
    "author_emphasis_help": (
        "サイドバーで著者を選ぶと、出力中のその名前が太字になります。",
        "When you pick authors in the sidebar, their names are bolded in the output.",
    ),
    "copy_hint": (
        "👇 ドラッグで選択してコピーすると、太字・斜体も保持されます。",
        "👇 Select and copy the text below to keep bold/italic formatting.",
    ),
    "plain_expander": (
        "コピー用プレーンテキスト（書式なし）",
        "Plain text (no styling)",
    ),
    "no_match_info": (
        "条件に合う業績がありません。絞り込みを見直してください。",
        "No publications match. Try adjusting the filters.",
    ),
    "copy_all_header": ("📋 すべてまとめてコピー", "📋 Copy everything at once"),
    "copy_all_hint": (
        "選択中の全種別を1つにまとめました。下のリッチ表示をドラッグコピーすると書式も保持されます。",
        "All selected types combined into one. Drag-copy the rich text below to keep formatting.",
    ),
    "fy_heading": ("{y}年度", "FY {y}"),
}


# 業績種別ラベル（schema.RECORD_TYPES のキーに対応）
RECORD_TYPE_LABELS: dict[str, tuple[str, str]] = {
    "paper": ("原著論文・英文総説", "Original Papers / English Reviews"),
    "book": ("著書・和文総説", "Books / Japanese Reviews"),
    "presentation": ("発表・講演", "Presentations"),
    "award": ("受賞", "Awards"),
    "outreach": ("アウトリーチ", "Outreach"),
    "publicity": ("広報・パブリシティ", "Publicity"),
}


# 書式の差し込み項目ラベル
PLACEHOLDER_LABELS: dict[str, tuple[str, str]] = {
    "authors": ("著者", "Authors"),
    "title": ("タイトル", "Title"),
    "year": ("発行年（西暦）", "Year"),
    "date": ("日付（年月日）", "Date"),
    "journal": ("雑誌名（正式）", "Journal (full)"),
    "journal_abbr": ("雑誌名（略称）", "Journal (abbrev.)"),
    "volume": ("巻", "Volume"),
    "issue": ("号", "Issue"),
    "pages": ("ページ", "Pages"),
    "doi": ("DOI", "DOI"),
    "book_title": ("本・雑誌タイトル", "Book/Journal title"),
    "review_title": ("総説タイトル", "Review title"),
    "chapter": ("担当章", "Chapter"),
    "editor": ("編者", "Editor"),
    "publisher": ("出版社", "Publisher"),
    "isbn": ("ISBN", "ISBN"),
    "issn": ("ISSN", "ISSN"),
    "conference": ("学会・イベント名", "Conference/Event"),
    "symposium": ("シンポジウム名", "Symposium"),
    "invited": ("招待（〇/×）", "Invited (〇/×)"),
    "venue": ("会場", "Venue"),
    "presentation_type": ("発表形態", "Presentation type"),
    "scope": ("国内/国際", "Domestic/Intl"),
    "awarded_study": ("対象研究", "Awarded study"),
    "organization": ("授与機関", "Organization"),
    "media_type": ("メディア種別", "Media type"),
    "media_name": ("メディア名", "Media name"),
    "link": ("リンク", "Link"),
}


# テンプレートのプリセット名ラベル（templates.yaml のキーに対応。未知のキーはそのまま表示）
PRESET_LABELS: dict[str, tuple[str, str]] = {
    "科研費": ("科研費", "KAKENHI"),
    "業績一覧（年度別・番号付き）": (
        "業績一覧（年度別・番号付き）",
        "List (by FY, numbered)",
    ),
}


def _pick(pair: tuple[str, str], lang: str) -> str:
    return pair[1] if lang == "en" else pair[0]


def tr(key: str, lang: str) -> str:
    # キー欠落時は key をそのまま返す（rt_label/ph_label と対称のフォールバック）。
    return _pick(STRINGS.get(key, (key, key)), lang)


def rt_label(rtype: str, lang: str) -> str:
    return _pick(RECORD_TYPE_LABELS.get(rtype, (rtype, rtype)), lang)


def ph_label(key: str, lang: str) -> str:
    return _pick(PLACEHOLDER_LABELS.get(key, (key, key)), lang)


def preset_label(name: str, lang: str) -> str:
    return _pick(PRESET_LABELS.get(name, (name, name)), lang)
