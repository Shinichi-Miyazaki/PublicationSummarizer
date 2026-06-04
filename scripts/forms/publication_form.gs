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

  // 種別ラジオの各選択肢を、対応セクションへの分岐に設定。
  var choices = TYPE_ORDER.map(function (type) {
    return typeItem.createChoice(typeChoiceText_(type), pageBreakByType[type]);
  });
  typeItem.setChoices(choices);

  // 設問マップを保存（route が itemId から種別・フィールドを引く）。
  PropertiesService.getScriptProperties().setProperty(PROP_KEY, JSON.stringify({
    reporterId: String(reporterItem.getId()),
    typeId: String(typeItem.getId()),
    items: itemMap
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

  var typeLabel = byId[map.typeId];
  var type = labelToType_(typeLabel);
  if (!type) {
    Logger.log("[route] 種別を判定できませんでした: " + typeLabel);
    return;
  }
  var spec = FIELD_MAP[type];

  // この種別の論理フィールド値を収集。
  var values = {};
  responses.forEach(function (r) {
    var meta = map.items[String(r.getItem().getId())];
    if (meta && meta.type === type) {
      values[meta.field] = normalizeValue_(meta.field, r.getResponse());
    }
  });

  var ss = SpreadsheetApp.openById(CANONICAL_SHEET_ID);
  var sheet = ss.getSheetByName(spec.tab);
  if (!sheet) {
    Logger.log("[route] タブが見つかりません: " + spec.tab);
    return;
  }

  // DOI から論文情報を自動補完（空欄のみ）。失敗時は黙って通常追記。
  var notes = [];
  if (enrichFromDoi_(type, values)) {
    notes.push("crossref");
  }

  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

  // 重複検出（DOI、無ければ 日付+タイトル先頭）。見つかれば note にフラグして残す。
  var dupOf = findDuplicate_(sheet, header, values);
  if (dupOf) {
    notes.push("dup_of=" + dupOf);
  }

  var recordId = spec.prefix + "-" + pad4_(sheet.getLastRow()); // header 行込みの行数を採番に使う。
  var reporter = byId[map.reporterId] || "";

  var meta = {
    record_id: recordId,
    status: APP_STATUS_NEW,
    submitter: reporter,
    source: SOURCE_LABEL,
    created_at: nowStamp_(),
    note: notes.join("; ")
  };

  // シートのヘッダ順に合わせて 1 行組み立てる（列順変更にも追従）。
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
function doiKeyOf_(doi) {
  doi = String(doi || "").trim().toLowerCase();
  return doi ? ("doi:" + doi) : "";
}
function dtKeyOf_(date, title) {
  return "dt:" + ymOf_(date) + "|" + String(title || "").trim().toLowerCase().slice(0, 40);
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

/** 既存行を走査し、重複（DOI 一致 or 年月+タイトル一致）する行の record_id を返す。 */
function findDuplicate_(sheet, header, values) {
  var last = sheet.getLastRow();
  if (last < 2) return "";
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  var newDoi = doiKeyOf_(values.doi);
  var newDt = dtKeyOf_(values.date, recTitleOf_(values));
  var data = sheet.getRange(2, 1, last - 1, header.length).getValues();
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    function cell(name) { return name in col ? row[col[name]] : ""; }
    var t = String(cell("title_ja") || cell("title_en") ||
                   cell("book_title_ja") || cell("book_title_en") || "").trim();
    var doi = doiKeyOf_(cell("doi"));
    var dt = dtKeyOf_(cell("date"), t);
    if ((newDoi && doi === newDoi) || dt === newDt) {
      return String(cell("record_id") || "").trim() || "(既存)";
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
