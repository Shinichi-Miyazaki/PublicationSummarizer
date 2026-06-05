/**
 * 業績登録フォーム ― 「1フォーム＋自動取込」Apps Script
 * ============================================================
 * これ 1 ファイルで、業績登録用の Google フォームを生成し、回答を
 * Canonical スプレッドシート（本アプリの DB）の該当タブへ自動追記します。
 *
 * 使い方（詳細は docs/google-forms.md）:
 *   1) https://script.google.com で新規プロジェクトを作り、このファイルを丸ごと貼り付け。
 *   2) 下の CANONICAL_SHEET_ID を、自分の Canonical スプレッドシートの ID に書き換え。
 *   3) 関数 buildForm を 1 回だけ実行（初回は認可ダイアログで「許可」）。
 *   4) 実行ログ（表示 → ログ）に出る「公開用 URL」をメンバーへ配布。
 *
 * 仕組み:
 *   - 先頭で「報告者氏名」と「業績種別」を尋ね、種別に応じて該当セクションへ分岐。
 *   - 送信されると onFormSubmit トリガ（route）が起動し、選ばれた種別の値だけを
 *     Canonical の該当タブへ status=未確認 で 1 行追記する。
 *   - キュレーターが内容を確認し status を「確認済」に変えた行だけ、アプリに反映される。
 *
 * 整合性:
 *   FIELD_MAP の tab / prefix / fields は publication_summarizer/schema.py（論理フィールド）
 *   および scripts/ingest_to_canonical.py（TAB_NAME / ID_PREFIX / CANONICAL_FIELDS）と
 *   一致させること。tests/test_form_fields.py がこの一致を自動チェックする。
 */

// ▼▼▼ ここだけ書き換える ▼▼▼
var CANONICAL_SHEET_ID = "1_7b_-6EsRNr6tW1naDj8QJ5M0espE5Wv";
// ▲▲▲ ここだけ書き換える ▲▲▲

// Canonical 各タブの先頭メタ列（schema.py / ingest と同一）。
var META_FIELDS = ["record_id", "status", "submitter", "source", "created_at", "note"];
var APP_STATUS_NEW = "未確認"; // 取込直後の status。確認後にキュレーターが「確認済」へ。
var SOURCE_LABEL = "form";

/**
 * 種別ごとの設問定義。
 * tab/prefix/fields は schema.py・ingest と厳密一致（tests/test_form_fields.py で検証）。
 * 本体は strict JSON（コメント・末尾カンマ禁止）にして Python から抽出できるようにする。
 * questions[].field の並びが fields と一致する。
 */
// FIELD_MAP_JSON_BEGIN
var FIELD_MAP = {
  "paper": {
    "tab": "Original Papers",
    "prefix": "PAP",
    "label": "原著論文・英文総説",
    "label_en": "Original Papers / English Reviews",
    "questions": [
      {"field": "date", "title": "発行日", "title_en": "Publication date", "type": "date", "required": true, "help": "例 / e.g. 2026/04/10"},
      {"field": "category", "title": "区分", "title_en": "Category", "type": "radio", "required": true, "choices": ["原著論文", "英文総説"], "help": "原著論文 = Original article / 英文総説 = English review"},
      {"field": "peer_reviewed", "title": "査読の有無", "title_en": "Peer review", "type": "radio", "required": true, "choices": ["査読あり", "査読なし"], "help": "査読あり = Peer-reviewed / 査読なし = Not peer-reviewed"},
      {"field": "authors", "title": "著者（記載順に全員）", "title_en": "Authors (in listed order)", "type": "paragraph", "required": true, "help": "例 / e.g. Yamada T, Hayashi N, Suzuki I"},
      {"field": "title_ja", "title": "論文タイトル（日本語・任意）", "title_en": "Title (Japanese, optional)", "type": "text", "required": false, "help": "例 / e.g. マウスの社会的順位とレム睡眠"},
      {"field": "title_en", "title": "論文タイトル（English）", "title_en": "Title (English)", "type": "text", "required": true, "help": "例 / e.g. Social rank affects REM sleep in mice"},
      {"field": "journal_ja", "title": "雑誌名（日本語・任意）", "title_en": "Journal (Japanese, optional)", "type": "text", "required": false, "help": "例 / e.g. 実験医学"},
      {"field": "journal_en", "title": "雑誌名（English・正式名称）", "title_en": "Journal (English, full name)", "type": "text", "required": true, "help": "例 / e.g. Scientific Reports"},
      {"field": "journal_abbr_ja", "title": "略誌名（日本語・任意）", "title_en": "Journal abbrev. (Japanese, optional)", "type": "text", "required": false},
      {"field": "journal_abbr_en", "title": "略誌名（English）", "title_en": "Journal abbrev. (English)", "type": "text", "required": false, "help": "例 / e.g. Sci. Rep."},
      {"field": "volume", "title": "巻（Volume）", "title_en": "Volume", "type": "text", "required": false, "help": "例 / e.g. 16"},
      {"field": "issue", "title": "号（Issue）", "title_en": "Issue", "type": "text", "required": false, "help": "例 / e.g. 1"},
      {"field": "pages", "title": "ページ", "title_en": "Pages", "type": "text", "required": false, "help": "例 / e.g. 871 または / or 12-20"},
      {"field": "doi", "title": "DOI", "title_en": "DOI", "type": "text", "required": false, "doi": true, "help": "例 / e.g. 10.1038/s41598-025-32402-2（入れると英語情報を自動補完 / auto-fills English info）"}
    ]
  },
  "book": {
    "tab": "Books",
    "prefix": "BK",
    "label": "著書・和文総説",
    "label_en": "Books / Japanese Reviews",
    "questions": [
      {"field": "date", "title": "発行日", "title_en": "Publication date", "type": "date", "required": true, "help": "例 / e.g. 2025/11/01"},
      {"field": "international", "title": "国内/国際", "title_en": "Domestic / International", "type": "radio", "required": true, "choices": ["国内", "国際"], "help": "国内 = Domestic / 国際 = International"},
      {"field": "peer_reviewed", "title": "査読の有無", "title_en": "Peer review", "type": "radio", "required": false, "choices": ["査読あり", "査読なし"], "help": "査読あり = Peer-reviewed / 査読なし = Not peer-reviewed"},
      {"field": "authors", "title": "著者", "title_en": "Authors", "type": "paragraph", "required": true, "help": "例 / e.g. 山田 太郎, 鈴木 一郎"},
      {"field": "review_title_ja", "title": "章・総説タイトル（日本語）", "title_en": "Chapter/Review title (Japanese)", "type": "text", "required": false, "help": "例 / e.g. 睡眠覚醒の制御機構"},
      {"field": "review_title_en", "title": "章・総説タイトル（English・任意）", "title_en": "Chapter/Review title (English, optional)", "type": "text", "required": false},
      {"field": "book_title_ja", "title": "書名（日本語）", "title_en": "Book title (Japanese)", "type": "text", "required": true, "help": "例 / e.g. 最新・睡眠科学"},
      {"field": "book_title_en", "title": "書名（English・任意）", "title_en": "Book title (English, optional)", "type": "text", "required": false},
      {"field": "chapter", "title": "章（Chapter）", "title_en": "Chapter", "type": "text", "required": false, "help": "例 / e.g. 3"},
      {"field": "editor", "title": "編者", "title_en": "Editor(s)", "type": "text", "required": false, "help": "例 / e.g. 鈴木 一郎"},
      {"field": "volume", "title": "巻", "title_en": "Volume", "type": "text", "required": false},
      {"field": "issue", "title": "号", "title_en": "Issue", "type": "text", "required": false},
      {"field": "pages", "title": "ページ", "title_en": "Pages", "type": "text", "required": false, "help": "例 / e.g. 45-60"},
      {"field": "publisher", "title": "出版社", "title_en": "Publisher", "type": "text", "required": false, "help": "例 / e.g. 医学書院"},
      {"field": "doi", "title": "DOI", "title_en": "DOI", "type": "text", "required": false, "doi": true},
      {"field": "issn", "title": "ISSN", "title_en": "ISSN", "type": "text", "required": false},
      {"field": "isbn", "title": "ISBN", "title_en": "ISBN", "type": "text", "required": false, "help": "例 / e.g. 978-4-260-00000-0"}
    ]
  },
  "presentation": {
    "tab": "presentations",
    "prefix": "PRE",
    "label": "発表・講演",
    "label_en": "Presentations",
    "questions": [
      {"field": "date", "title": "発表日", "title_en": "Presentation date", "type": "date", "required": true, "help": "例 / e.g. 2025/09/20"},
      {"field": "scope", "title": "国内/国際", "title_en": "Domestic / International", "type": "radio", "required": true, "choices": ["国内", "国際"], "help": "国内 = Domestic / 国際 = International"},
      {"field": "title_ja", "title": "演題（日本語）", "title_en": "Presentation title (Japanese)", "type": "text", "required": true, "help": "例 / e.g. 睡眠とストレスの関係"},
      {"field": "title_en", "title": "演題（English・任意）", "title_en": "Presentation title (English, optional)", "type": "text", "required": false},
      {"field": "authors", "title": "発表者（連名は記載順に全員）", "title_en": "Presenters (in listed order)", "type": "paragraph", "required": true, "help": "例 / e.g. 山田 太郎, 林 直子"},
      {"field": "conference_ja", "title": "学会・研究会名（日本語）", "title_en": "Conference (Japanese)", "type": "text", "required": true, "help": "例 / e.g. 日本神経科学大会"},
      {"field": "conference_en", "title": "学会・研究会名(English・任意)", "title_en": "Conference (English, optional)", "type": "text", "required": false, "help": "例 / e.g. Annual Meeting of JNS"},
      {"field": "symposium_ja", "title": "シンポジウム名（日本語・任意）", "title_en": "Symposium (Japanese, optional)", "type": "text", "required": false},
      {"field": "symposium_en", "title": "シンポジウム名（English・任意）", "title_en": "Symposium (English, optional)", "type": "text", "required": false},
      {"field": "invited", "title": "招待の有無", "title_en": "Invited", "type": "radio", "required": false, "choices": ["招待あり", "招待なし"], "help": "招待あり = Invited / 招待なし = Not invited"},
      {"field": "venue", "title": "開催地", "title_en": "Venue", "type": "text", "required": false, "help": "例 / e.g. 横浜 / Yokohama"},
      {"field": "presentation_type", "title": "発表形式", "title_en": "Presentation type", "type": "radio", "required": false, "choices": ["口頭", "ポスター"], "help": "口頭 = Oral / ポスター = Poster"}
    ]
  },
  "award": {
    "tab": "Awards",
    "prefix": "AWD",
    "label": "受賞",
    "label_en": "Awards",
    "questions": [
      {"field": "date", "title": "受賞日", "title_en": "Award date", "type": "date", "required": true, "help": "例 / e.g. 2025/12/05"},
      {"field": "scope", "title": "国内/国際", "title_en": "Domestic / International", "type": "radio", "required": true, "choices": ["国内", "国際"], "help": "国内 = Domestic / 国際 = International"},
      {"field": "authors", "title": "受賞者", "title_en": "Awardee(s)", "type": "text", "required": true, "help": "例 / e.g. 山田 太郎"},
      {"field": "title_ja", "title": "賞の名称（日本語）", "title_en": "Award name (Japanese)", "type": "text", "required": true, "help": "例 / e.g. 若手奨励賞"},
      {"field": "title_en", "title": "賞の名称（English・任意）", "title_en": "Award name (English, optional)", "type": "text", "required": false, "help": "例 / e.g. Young Investigator Award"},
      {"field": "awarded_study", "title": "受賞対象の研究・業績", "title_en": "Awarded study / work", "type": "paragraph", "required": false, "help": "例 / e.g. 睡眠制御に関する一連の研究"},
      {"field": "organization", "title": "授与団体", "title_en": "Awarding organization", "type": "text", "required": false, "help": "例 / e.g. 日本睡眠学会"}
    ]
  },
  "outreach": {
    "tab": "Outreach",
    "prefix": "OUT",
    "label": "アウトリーチ",
    "label_en": "Outreach",
    "questions": [
      {"field": "date", "title": "実施日", "title_en": "Date", "type": "date", "required": true, "help": "例 / e.g. 2025/08/03"},
      {"field": "scope", "title": "国内/国際", "title_en": "Domestic / International", "type": "radio", "required": true, "choices": ["国内", "国際"], "help": "国内 = Domestic / 国際 = International"},
      {"field": "authors", "title": "実施者", "title_en": "Organizer(s)", "type": "text", "required": true, "help": "例 / e.g. 山田 太郎"},
      {"field": "title_ja", "title": "活動概要（日本語）", "title_en": "Activity summary (Japanese)", "type": "paragraph", "required": true, "help": "例 / e.g. 市民講座「睡眠のふしぎ」"},
      {"field": "title_en", "title": "活動概要（English・任意）", "title_en": "Activity summary (English, optional)", "type": "paragraph", "required": false},
      {"field": "venue", "title": "開催地・媒体", "title_en": "Venue / Media", "type": "text", "required": false, "help": "例 / e.g. 市民会館"}
    ]
  },
  "publicity": {
    "tab": "Publicity",
    "prefix": "PUB",
    "label": "広報・パブリシティ",
    "label_en": "Publicity",
    "questions": [
      {"field": "date", "title": "掲載日", "title_en": "Publication date", "type": "date", "required": true, "help": "例 / e.g. 2026/01/15"},
      {"field": "media_type", "title": "媒体種別", "title_en": "Media type", "type": "select", "required": true, "choices": ["新聞", "TV", "Web", "雑誌", "その他"], "help": "新聞=Newspaper / TV=TV / Web=Web / 雑誌=Magazine / その他=Other"},
      {"field": "media_name", "title": "媒体名", "title_en": "Media name", "type": "text", "required": true, "help": "例 / e.g. ○○新聞"},
      {"field": "authors", "title": "掲載人物", "title_en": "Featured person(s)", "type": "text", "required": true, "help": "例 / e.g. 山田 太郎"},
      {"field": "title_ja", "title": "掲載概要（日本語）", "title_en": "Summary (Japanese)", "type": "paragraph", "required": true, "help": "例 / e.g. 研究室の睡眠研究が紹介された"},
      {"field": "title_en", "title": "掲載概要（English・任意）", "title_en": "Summary (English, optional)", "type": "paragraph", "required": false},
      {"field": "link", "title": "リンク（URL）", "title_en": "Link (URL)", "type": "text", "required": false, "help": "例 / e.g. https://example.com/article"}
    ]
  }
};
// FIELD_MAP_JSON_END

// 種別の並び（フォームのセクション順・ラジオ選択肢順）。
var TYPE_ORDER = ["paper", "book", "presentation", "award", "outreach", "publicity"];

var PROP_KEY = "FORM_MAP"; // Script Properties に保存する設問マップのキー。
var DOI_PATTERN = "^10\\.\\d{4,9}/.+$";

/**
 * フォームを生成し、分岐・検証・onFormSubmit トリガを設定する。
 * 初回のみ実行（再実行すると新しいフォームが作られる点に注意）。
 */
function buildForm() {
  var form = FormApp.create("業績登録フォーム / Publication Registration");
  form.setDescription(
    "研究業績を登録します。最初に種別を選ぶと、その種別に必要な項目だけが表示されます。\n" +
    "Register a publication. Choose the record type first; only the relevant fields will appear.\n" +
    "各設問に記入例があります。タイトル・雑誌名などは日本語/英語の両方を入力できます（分かる方だけでも可）。\n" +
    "Each question shows an example. Titles/journals accept both Japanese and English (either is fine)."
  );
  form.setCollectEmail(true);

  // 先頭: 全種別共通の設問。
  var reporterItem = form.addTextItem()
    .setTitle("報告者氏名 / Reporter name")
    .setHelpText("登録するあなたの氏名 / Your name. 例 / e.g. 山田 太郎")
    .setRequired(true);

  var typeItem = form.addMultipleChoiceItem()
    .setTitle("業績種別 / Record type")
    .setHelpText("登録する業績の種類を1つ選ぶと該当欄へ進みます / Pick one type to jump to its section.")
    .setRequired(true);

  // 種別ごとにセクション（PageBreak）と設問を作る。
  var itemMap = {};            // itemId -> {type, field}
  var pageBreakByType = {};    // type -> PageBreakItem

  TYPE_ORDER.forEach(function (type) {
    var page = form.addPageBreakItem().setTitle(typeChoiceText_(type));
    pageBreakByType[type] = page;

    FIELD_MAP[type].questions.forEach(function (q) {
      var item = addQuestion_(form, q);
      itemMap[String(item.getId())] = {type: type, field: q.field};
    });

    // セクション末尾に到達したら送信（他種別のセクションへ流れ込ませない）。
    page.setGoToPage(FormApp.PageNavigationType.SUBMIT);
  });

  // 一括貼り付けセクション（複数件をまとめて登録）。
  var bulkPage = form.addPageBreakItem().setTitle("まとめて貼り付け / Bulk paste");
  var bulkTypeItem = form.addListItem()
    .setTitle("貼り付ける業績の種別 / Type of the pasted items")
    .setHelpText("貼り付けるリストの種別を選んでください（1回の送信につき1種別）。")
    .setRequired(true)
    .setChoiceValues(TYPE_ORDER.map(function (t) { return typeChoiceText_(t); }));
  var bulkTextItem = form.addParagraphTextItem()
    .setTitle("業績リスト（researchmap 等からプレーンテキストで貼り付け） / Paste your list")
    .setHelpText(
      "1 件ずつ改行。1 件の並びは「タイトル → 著者 → 誌名/学会名＋日付」。\n" +
      "末尾に日付がある行（例: 2025年7月 / Jul, 2025 / 2025/07）が 1 件の区切りです。\n" +
      "Paste one item per block: Title / Authors / Journal-or-Conference + Date (date ends each item)."
    )
    .setRequired(true);
  bulkPage.setGoToPage(FormApp.PageNavigationType.SUBMIT);

  // 種別ラジオの各選択肢を、対応セクションへの分岐に設定（最後に一括貼り付け）。
  var bulkChoiceLabel = "まとめて貼り付け（複数件を一度に） / Bulk paste (multiple at once)";
  var choices = TYPE_ORDER.map(function (type) {
    return typeItem.createChoice(typeChoiceText_(type), pageBreakByType[type]);
  });
  choices.push(typeItem.createChoice(bulkChoiceLabel, bulkPage));
  typeItem.setChoices(choices);

  // 設問マップを保存（route が itemId から種別・フィールドを引く）。
  PropertiesService.getScriptProperties().setProperty(PROP_KEY, JSON.stringify({
    reporterId: String(reporterItem.getId()),
    typeId: String(typeItem.getId()),
    items: itemMap,
    bulkChoiceLabel: bulkChoiceLabel,
    bulkTypeId: String(bulkTypeItem.getId()),
    bulkTextId: String(bulkTextItem.getId())
  }));

  installTrigger_(form);

  var url = form.getPublishedUrl();
  Logger.log("フォームを作成しました。");
  Logger.log("公開用 URL（メンバーへ配布）: " + url);
  Logger.log("編集用 URL（あなた専用）: " + form.getEditUrl());
  return url;
}

/** 設問定義 1 件をフォームへ追加して Item を返す。 */
function addQuestion_(form, q) {
  var item;
  switch (q.type) {
    case "paragraph":
      item = form.addParagraphTextItem();
      break;
    case "date":
      item = form.addDateItem();
      break;
    case "radio":
      item = form.addMultipleChoiceItem()
        .setChoiceValues(q.choices || []);
      break;
    case "select":
      item = form.addListItem()
        .setChoiceValues(q.choices || []);
      break;
    case "text":
    default:
      item = form.addTextItem();
      if (q.doi) {
        item.setValidation(
          FormApp.createTextValidation()
            .setHelpText("DOI は 10.xxxx/... の形式で入力してください（任意）/ Format: 10.xxxx/... (optional)")
            .requireTextMatchesPattern(DOI_PATTERN)
            .build()
        );
      }
      break;
  }
  item.setTitle(qTitle_(q)).setRequired(!!q.required);
  if (q.help) item.setHelpText(q.help);
  return item;
}

/** 設問タイトルを日英併記で返す（title_en があれば「日本語 / English」）。 */
function qTitle_(q) {
  return q.title_en ? (q.title + " / " + q.title_en) : q.title;
}

/** 種別の表示名（ラジオ選択肢・セクション見出し）を日英併記で返す。 */
function typeChoiceText_(type) {
  var s = FIELD_MAP[type];
  return s.label_en ? (s.label + " / " + s.label_en) : s.label;
}

/** route の onFormSubmit トリガを（重複なく）設置する。 */
function installTrigger_(form) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "route") {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger("route").forForm(form).onFormSubmit().create();
}

/**
 * フォーム送信トリガ本体。回答を Canonical の該当タブへ status=未確認 で追記する。
 * @param {Object} e onFormSubmit イベント（e.response: FormResponse）
 */
function route(e) {
  var map = JSON.parse(PropertiesService.getScriptProperties().getProperty(PROP_KEY));
  var responses = e.response.getItemResponses();

  // itemId -> 回答値。
  var byId = {};
  responses.forEach(function (r) {
    byId[String(r.getItem().getId())] = r.getResponse();
  });

  var reporter = byId[map.reporterId] || "";
  var topLabel = byId[map.typeId];

  // 一括貼り付けが選ばれた場合は、貼り付けテキストを解析して複数件を追記。
  if (map.bulkChoiceLabel && topLabel === map.bulkChoiceLabel) {
    routeBulk_(byId, map, reporter);
    return;
  }

  var type = labelToType_(topLabel);
  if (!type) {
    Logger.log("[route] 種別を判定できませんでした: " + topLabel);
    return;
  }

  // この種別の論理フィールド値を収集。
  var values = {};
  responses.forEach(function (r) {
    var meta = map.items[String(r.getItem().getId())];
    if (meta && meta.type === type) {
      values[meta.field] = normalizeValue_(meta.field, r.getResponse());
    }
  });

  var ss = SpreadsheetApp.openById(CANONICAL_SHEET_ID);
  appendOne_(ss, type, values, reporter, SOURCE_LABEL);
}

/** 一括貼り付け: 種別を判定し、貼り付けテキストを解析して 1 件ずつ追記。 */
function routeBulk_(byId, map, reporter) {
  var type = labelToType_(byId[map.bulkTypeId]);
  if (!type) {
    Logger.log("[routeBulk] 種別を判定できませんでした: " + byId[map.bulkTypeId]);
    return;
  }
  var text = String(byId[map.bulkTextId] || "");
  var recs = parseRecords_(text, type);
  var ss = SpreadsheetApp.openById(CANONICAL_SHEET_ID);
  var n = 0;
  recs.forEach(function (rec) {
    appendOne_(ss, type, rec, reporter, "paste-form");
    n++;
  });
  Logger.log("[routeBulk] " + type + " を " + n + " 件追記しました。");
}

/**
 * 1 件を Canonical の該当タブへ追記する（DOI補完・重複フラグ・採番・status=未確認）。
 * values は論理フィールド（_ja/_en）か base 名（title 等）でよい。base は言語で振り分ける。
 */
function appendOne_(ss, type, values, reporter, source) {
  ensureBilingualValues_(values);
  var spec = FIELD_MAP[type];
  var sheet = ss.getSheetByName(spec.tab);
  if (!sheet) {
    Logger.log("[appendOne] タブが見つかりません: " + spec.tab);
    return;
  }

  var notes = [];
  if (enrichFromDoi_(type, values)) notes.push("crossref");

  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var dupOf = findDuplicate_(sheet, header, values, type);
  if (dupOf) notes.push("dup_of=" + dupOf);

  var meta = {
    record_id: spec.prefix + "-" + pad4_(sheet.getLastRow()),
    status: APP_STATUS_NEW,
    submitter: reporter,
    source: source,
    created_at: nowStamp_(),
    note: notes.join("; ")
  };
  var row = header.map(function (h) {
    var key = String(h).trim();
    if (key in meta) return meta[key];
    return (key in values) ? values[key] : "";
  });
  sheet.appendRow(row);
}

/** 日付を 年/月（YYYY/MM）へ正規化（2025/7・2025-07-01・2025年7月 を吸収）。 */
function ymOf_(s) {
  var m = String(s || "").match(/(\d{4})\D+(\d{1,2})/);
  return m ? (m[1] + "/" + ("0" + m[2]).slice(-2)) : String(s || "").trim();
}
function cleanDoi_(doi) {
  var d = String(doi || "").trim().toLowerCase();
  return d.replace(/^\s*(https?:\/\/(dx\.)?doi\.org\/|doi\s*[:：]\s*)/, "").trim();
}
function normTitle_(t) {
  return String(t || "").toLowerCase().replace(/[^0-9a-z぀-ヿ㐀-鿿]/g, "");
}
/** 重複検出キーの配列（いずれか一致で重複）。論文・著書はタイトル一致のみでも重複。 */
function dupKeysOf_(doi, date, title, titleOnly) {
  var keys = [];
  var cd = cleanDoi_(doi);
  if (cd) keys.push("doi:" + cd);
  var nt = normTitle_(title);
  if (titleOnly && nt.length >= 8) keys.push("t:" + nt);
  keys.push("dt:" + ymOf_(date) + "|" + nt.slice(0, 40));
  return keys;
}

// ── 一括貼り付けの解析（ingest_paste.py の移植） ──────────────────
var BILINGUAL_BASES = ["title", "journal", "journal_abbr", "book_title",
                       "review_title", "conference", "symposium"];
var PASTE_TITLE_FIELD = {paper: "title", book: "review_title", presentation: "title",
                         award: "title", outreach: "title", publicity: "title"};
var PASTE_VENUE_FIELD = {paper: "journal", book: "book_title", presentation: "conference",
                         award: "organization", outreach: "venue", publicity: "media_name"};
var EN_MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};

function hasCjk_(s) {
  return /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(String(s || ""));
}

/** base 値（title 等）を本文の言語で _ja/_en に振り分ける（_ja/_en が既にあれば優先）。 */
function ensureBilingualValues_(v) {
  BILINGUAL_BASES.forEach(function (base) {
    if (v[base] == null) return;
    var val = String(v[base]).trim();
    delete v[base];
    if (!val) return;
    var slot = base + (hasCjk_(val) ? "_ja" : "_en");
    if (!String(v[slot] || "").trim()) v[slot] = val;
  });
}

/** 行から日付を検出して {start, dateStr} を返す（日本語/英語/数値）。無ければ null。 */
function findDate_(line) {
  var cands = [];
  var m = /(\d{4})年\s*(\d{1,2})月(?:\s*(\d{1,2})日)?/.exec(line);
  if (m) cands.push({start: m.index, y: +m[1], mo: +m[2], d: m[3]});
  m = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b[.,]?\s*(?:(\d{1,2})\s*,?\s*)?(\d{4})/i.exec(line);
  if (m) cands.push({start: m.index, y: +m[3], mo: EN_MONTHS[m[1].toLowerCase().slice(0, 3)], d: m[2]});
  m = /(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/.exec(line);
  if (m) cands.push({start: m.index, y: +m[1], mo: +m[2], d: m[3]});
  if (!cands.length) return null;
  cands.sort(function (a, b) { return a.start - b.start; });
  var c = cands[0];
  return {start: c.start, dateStr: c.d ? (c.y + "/" + c.mo + "/" + (+c.d)) : (c.y + "/" + c.mo)};
}

function looksLikeAuthors_(line) {
  return line.indexOf(",") >= 0 || line.indexOf("，") >= 0 || line.indexOf("、") >= 0;
}

/** 日付より前の部分（誌名・巻号頁）を分解して rec に入れる。 */
function parseSource_(head, rtype, rec) {
  var venue = head;
  if (rtype === "paper" || rtype === "book") {
    var vi = /(\d+)\s*\(\s*(\d+)\s*\)/.exec(venue);
    if (vi) { rec.volume = vi[1]; rec.issue = vi[2]; venue = venue.replace(vi[0], " "); }
    var pg = /(\d+)\s*[-–—―]\s*(\d+)/.exec(venue);
    if (pg) { rec.pages = pg[1] + "-" + pg[2]; venue = venue.replace(pg[0], " "); }
  }
  venue = venue.replace(/\s{2,}/g, " ").replace(/^[\s,，、]+|[\s,，、]+$/g, "");
  if (venue) rec[PASTE_VENUE_FIELD[rtype]] = venue;
}

/** プレーンテキストを種別 rtype のレコード配列（base フィールド）へ解析。 */
function parseRecords_(text, rtype) {
  var lines = String(text).split(/\r?\n/).map(function (s) { return s.trim(); })
    .filter(function (s) { return s.length; });
  var records = [], buf = [];
  var paperLike = (rtype === "paper" || rtype === "book");

  lines.forEach(function (line) {
    var f = findDate_(line);
    if (!f) { buf.push(line); return; }
    var rec = {date: f.dateStr};
    parseSource_(line.slice(0, f.start), rtype, rec);
    if (buf.length) {
      if (buf.length >= 2 && (paperLike || looksLikeAuthors_(buf[buf.length - 1]))) {
        rec.authors = buf[buf.length - 1];
        rec[PASTE_TITLE_FIELD[rtype]] = buf.slice(0, -1).join(" ").replace(/[\s.。]+$/, "");
      } else {
        rec[PASTE_TITLE_FIELD[rtype]] = buf.join(" ").replace(/[\s.。]+$/, "");
      }
    }
    if (rec[PASTE_TITLE_FIELD[rtype]] || rec.authors) records.push(rec);
    buf = [];
  });
  return records;
}

/** values（新規）の代表タイトル（_ja 優先、無ければ _en、book は book_title）。 */
function recTitleOf_(v) {
  var keys = ["title_ja", "title_en", "book_title_ja", "book_title_en"];
  for (var i = 0; i < keys.length; i++) {
    var s = String(v[keys[i]] || "").trim();
    if (s) return s;
  }
  return "";
}

/** 既存行を走査し、重複（DOI / タイトル / 年月+タイトル のいずれか一致）行の record_id を返す。 */
function findDuplicate_(sheet, header, values, type) {
  var last = sheet.getLastRow();
  if (last < 2) return "";
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  var titleOnly = (type === "paper" || type === "book");
  var newKeys = {};
  dupKeysOf_(values.doi, values.date, recTitleOf_(values), titleOnly)
    .forEach(function (k) { newKeys[k] = true; });
  var data = sheet.getRange(2, 1, last - 1, header.length).getValues();
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var cell = function (name) { return name in col ? row[col[name]] : ""; };
    var t = String(cell("title_ja") || cell("title_en") ||
                   cell("book_title_ja") || cell("book_title_en") || "").trim();
    var keys = dupKeysOf_(cell("doi"), cell("date"), t, titleOnly);
    for (var j = 0; j < keys.length; j++) {
      if (newKeys[keys[j]]) return String(cell("record_id") || "").trim() || "(既存)";
    }
  }
  return "";
}

/** CrossRef から論文/著書情報を取得し values の空欄を補完。補完したら true。 */
function enrichFromDoi_(type, values) {
  if (type !== "paper" && type !== "book") return false;
  var doi = String(values.doi || "").trim();
  if (!doi) return false;
  var msg;
  try {
    var resp = UrlFetchApp.fetch("https://api.crossref.org/works/" + encodeURIComponent(doi),
                                 {muteHttpExceptions: true, followRedirects: true});
    if (resp.getResponseCode() !== 200) return false;
    msg = JSON.parse(resp.getContentText()).message;
  } catch (err) {
    return false;
  }
  if (!msg) return false;

  function first(a) { return (a && a.length) ? a[0] : ""; }
  function setIfEmpty(k, v) { if (v && !String(values[k] || "").trim()) values[k] = v; }

  setIfEmpty(type === "book" ? "book_title_en" : "title_en", first(msg.title));
  setIfEmpty("journal_en", first(msg["container-title"]));
  setIfEmpty("journal_abbr_en", first(msg["short-container-title"]));
  setIfEmpty("volume", msg.volume || "");
  setIfEmpty("issue", msg.issue || "");
  setIfEmpty("pages", msg.page || "");
  var dp = msg["published-print"] || msg["published-online"] || msg["issued"];
  if (dp && dp["date-parts"] && dp["date-parts"][0]) {
    var p = dp["date-parts"][0];
    setIfEmpty("date", p[0] + "/" + pad2_(p[1] || 1) + "/" + pad2_(p[2] || 1));
  }
  return true;
}

function pad2_(n) {
  var s = String(n);
  return s.length < 2 ? "0" + s : s;
}

/** 表示ラベル（日英併記 or 旧・日本語のみ）から内部種別キーを引く。 */
function labelToType_(label) {
  for (var i = 0; i < TYPE_ORDER.length; i++) {
    var t = TYPE_ORDER[i];
    if (typeChoiceText_(t) === label || FIELD_MAP[t].label === label) return t;
  }
  return null;
}

/** 値の整形（日付は yyyy/mm/dd に統一。loader._parse_date は両形式可だが既存データに合わせる）。 */
function normalizeValue_(field, value) {
  if (value == null) return "";
  if (field === "date" && typeof value === "string") {
    return value.replace(/-/g, "/"); // "2026-06-04" -> "2026/06/04"
  }
  return value;
}

function pad4_(n) {
  var s = String(n);
  while (s.length < 4) s = "0" + s;
  return s;
}

function nowStamp_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm:ss");
}
