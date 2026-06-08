/**
 * Canonical スプレッドシート用 キュレーター・ツール（確認作業の省力化）
 * ============================================================
 * このスクリプトは **Canonical スプレッドシートにコンテナバインド** して使う:
 *   1) 対象の Canonical スプレッドシートを開く。
 *   2) 拡張機能 → Apps Script を開き、このファイルを丸ごと貼り付けて保存。
 *   3) スプレッドシートを再読み込みすると、メニュー「業績DB」が出る。
 *      （初回のメニュー操作時に認可ダイアログが出るので「許可」）
 *
 * メニュー:
 *   - 選択行を承認(確認済)      … 選択した行の status を「確認済」に（アプリに反映される）
 *   - 選択行を未確認に戻す        … status を「未確認」に
 *   - 選択行を DOI で補完         … その行の DOI から CrossRef で空欄を補完
 *   - このタブの重複を再チェック   … 日付+タイトル/DOI が重複する後発行に note=dup_of を付ける
 *
 * 注意: 行選択は record タブ（Original Papers / presentations 等）で行うこと。
 */

var APP_STATUS_OK = "確認済";
var APP_STATUS_NEW = "未確認";

// 編集をロックするメタ列（ヘッダ名）。publication_form.gs の META_FIELDS と一致。
var META_FIELDS_LOCK = ["record_id", "status", "submitter", "source", "created_at", "note"];

// タブ名 → 種別（DOI 補完の対象判定に使用）。publication_form.gs と一致。
var TAB_TYPE = {
  "Original Papers": "paper", "Books": "book", "presentations": "presentation",
  "Awards": "award", "Outreach": "outreach", "Publicity": "publicity"
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu("業績DB")
    .addItem("選択行を承認(確認済)", "approveSelected")
    .addItem("選択行を未確認に戻す", "unapproveSelected")
    .addSeparator()
    .addItem("選択行を DOI で補完", "enrichSelectedDoi")
    .addItem("選択行をタイトルで補完(DOI検索)", "enrichSelectedByTitle")
    .addItem("このタブの重複を再チェック", "recheckDuplicates")
    .addSeparator()
    .addItem("色分けを設定（全タブ）", "highlightAllTabs")
    .addSeparator()
    .addItem("一括下書き: シートを準備", "stagingSetup")
    .addItem("一括下書き: 表に展開", "stagingExpand")
    .addItem("一括下書き: 取り込む", "stagingImport")
    .addSeparator()
    .addItem("メンバー編集を有効化（保護＋編集で未確認へ）", "setupMemberEditing")
    .addToUi();
}

function approveSelected() { setStatusSelected_(APP_STATUS_OK); }
function unapproveSelected() { setStatusSelected_(APP_STATUS_NEW); }

/** 選択行の status 列を一括設定。 */
function setStatusSelected_(status) {
  var sh = SpreadsheetApp.getActiveSheet();
  var col = headerCol_(sh, "status");
  if (col < 0) { toast_("このタブに status 列がありません"); return; }
  var n = 0;
  eachSelectedDataRow_(sh, function (r) {
    sh.getRange(r, col + 1).setValue(status);
    n++;
  });
  toast_(n + " 行を「" + status + "」にしました");
}

/** 選択行を CrossRef で補完（空欄のみ）。 */
function enrichSelectedDoi() {
  var sh = SpreadsheetApp.getActiveSheet();
  var type = TAB_TYPE[sh.getName()];
  if (!type) { toast_("record タブで実行してください"); return; }
  if (type !== "paper" && type !== "book") { toast_("DOI 補完は論文・著書のみ対応です"); return; }
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  if (!("doi" in col)) { toast_("doi 列がありません"); return; }
  var n = 0;
  eachSelectedDataRow_(sh, function (r) {
    var rowRange = sh.getRange(r, 1, 1, header.length);
    var row = rowRange.getValues()[0];
    var doi = String(row[col.doi] || "").trim();
    if (!doi) return;
    var msg = fetchCrossref_(doi);
    if (!msg) return;
    if (fillRowFromCrossref_(row, col, type, msg)) {
      var note = String(row[col.note] || "");
      if (col.note != null && note.indexOf("crossref") < 0) {
        row[col.note] = note ? note + "; crossref" : "crossref";
      }
      rowRange.setValues([row]);
      n++;
    }
  });
  toast_(n + " 行を DOI で補完しました");
}

/**
 * 選択行をタイトルで補完（論文のみ）。DOI 未入力の行をタイトル（＋著者）で CrossRef 検索し、
 * 十分一致する候補の DOI を入れてから、CrossRef で空欄を補完する。
 */
function enrichSelectedByTitle() {
  var sh = SpreadsheetApp.getActiveSheet();
  var type = TAB_TYPE[sh.getName()];
  if (type !== "paper") { toast_("タイトル検索は論文タブのみ対応です"); return; }
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  if (!("doi" in col)) { toast_("doi 列がありません"); return; }
  var found = 0, filled = 0;
  eachSelectedDataRow_(sh, function (r) {
    var rowRange = sh.getRange(r, 1, 1, header.length);
    var row = rowRange.getValues()[0];
    if (String(row[col.doi] || "").trim()) return;  // 既に DOI があれば DOI 補完側で対応
    var title = String(row[col.title_en] || row[col.title_ja] || "").trim();
    var authors = String(col.authors != null ? row[col.authors] : "").trim();
    var doi = resolveDoiByTitle_(title, authors);
    if (!doi) return;
    row[col.doi] = doi;
    found++;
    var msg = fetchCrossref_(doi);
    if (msg) fillRowFromCrossref_(row, col, type, msg);
    var note = String(col.note != null ? row[col.note] : "");
    if (col.note != null && note.indexOf("crossref-title") < 0) {
      row[col.note] = note ? note + "; crossref-title" : "crossref-title";
    }
    rowRange.setValues([row]);
    filled++;
  });
  toast_(found + " 行で DOI を特定（" + filled + " 行を補完）しました");
}

/** タイトルを単語トークンへ分解（小文字化・記号→空白・CJK は1トークン）。 */
function titleTokens_(s) {
  return String(s || "").toLowerCase()
    .replace(/[^0-9a-z぀-ヿ㐀-鿿]+/g, " ").trim()
    .split(/\s+/).filter(function (w) { return w.length; });
}

/** 2 つのタイトルが十分に一致するか（トークン Jaccard >= 0.6）。誤マッチ防止用。 */
function titleSimilar_(a, b) {
  var ta = titleTokens_(a), tb = titleTokens_(b);
  if (!ta.length || !tb.length) return false;
  var setB = {}; tb.forEach(function (w) { setB[w] = true; });
  var inter = 0, seen = {};
  ta.forEach(function (w) { if (setB[w] && !seen[w]) { inter++; seen[w] = true; } });
  var uni = {}; ta.concat(tb).forEach(function (w) { uni[w] = true; });
  var union = Object.keys(uni).length;
  return union > 0 && (inter / union) >= 0.6;
}

/** タイトル（＋著者）で CrossRef を検索し、十分一致する候補の DOI を返す（なければ ""）。 */
function resolveDoiByTitle_(title, authors) {
  title = String(title || "").trim();
  if (title.length < 8) return "";
  var query = encodeURIComponent(authors ? (title + " " + authors) : title);
  var url = "https://api.crossref.org/works?rows=5&select=DOI,title&query.bibliographic=" + query;
  var items;
  try {
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, followRedirects: true});
    if (resp.getResponseCode() !== 200) return "";
    items = ((JSON.parse(resp.getContentText()).message) || {}).items || [];
  } catch (err) {
    return "";
  }
  for (var i = 0; i < items.length; i++) {
    var ct = (items[i].title && items[i].title.length) ? items[i].title[0] : "";
    if (titleSimilar_(title, ct)) {
      var doi = String(items[i].DOI || "").trim();
      if (doi) return doi;
    }
  }
  return "";
}

/** アクティブタブ内の重複を再チェックし、後発行に note=dup_of を付ける。 */
function recheckDuplicates() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (!TAB_TYPE[sh.getName()]) { toast_("record タブで実行してください"); return; }
  var flagged = recheckSheet_(sh);
  toast_(flagged < 0 ? "note 列がありません（先に DB を v2 化してください）"
                     : flagged + " 件の重複候補に印を付けました");
}

/** 1 タブの重複を再チェックし note=dup_of を付ける。flagged 件数を返す（note 列なしは -1）。 */
function recheckSheet_(sh) {
  var last = sh.getLastRow();
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  if (col.note == null) return -1;
  if (last < 3) return 0;
  var titleOnly = (TAB_TYPE[sh.getName()] === "paper" || TAB_TYPE[sh.getName()] === "book");
  var data = sh.getRange(2, 1, last - 1, header.length).getValues();
  var seen = {}, flagged = 0;  // key -> 既存の record_id
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var c = function (name) { return name in col ? row[col[name]] : ""; };
    var t = String(c("title_ja") || c("title_en") || c("book_title_ja") || c("book_title_en") || "").trim();
    var keys = dupKeysOf_(c("doi"), c("date"), t, titleOnly);
    var first = "";
    for (var j = 0; j < keys.length; j++) { if (seen[keys[j]]) { first = seen[keys[j]]; break; } }
    if (first) {
      var note = String(row[col.note] || "");
      var tag = "dup_of=" + first;
      if (note.indexOf(tag) < 0) {
        sh.getRange(r + 2, col.note + 1).setValue(note ? note + "; " + tag : tag);
        flagged++;
      }
    } else {
      var rid = String(c("record_id") || "").trim() || ("行" + (r + 2));
      keys.forEach(function (k) { if (!seen[k]) seen[k] = rid; });
    }
  }
  return flagged;
}

/** 全 record タブで重複を再判定し、未確認＝黄背景／重複候補＝赤太字 の書式を設定する。 */
function highlightAllTabs() {
  var ss = SpreadsheetApp.getActive();
  var n = 0, noNote = 0;
  Object.keys(TAB_TYPE).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    if (recheckSheet_(sh) === -1) noNote++;  // 先に dup_of を付けてから着色
    applyHighlighting_(sh);
    n++;
  });
  toast_(n + " タブに色分けを設定しました（未確認=黄背景, 重複候補=赤太字）"
    + (noNote ? "／" + noNote + " タブは note 列なし=重複色不可（v2 化が必要）" : ""));
}

/** 1 タブに条件付き書式を設定（status≠確認済→黄背景, note に dup_of→赤太字）。 */
function applyHighlighting_(sh) {
  var statusCol = headerCol_(sh, "status");
  var noteCol = headerCol_(sh, "note");
  var idCol = headerCol_(sh, "record_id");
  if (statusCol < 0 || idCol < 0) return;
  var lastCol = sh.getLastColumn();
  var maxRow = sh.getMaxRows();
  var range = sh.getRange(2, 1, maxRow - 1, lastCol);
  var idL = colLetter_(idCol + 1);
  var stL = colLetter_(statusCol + 1);

  // 作り直す。未確認＝黄背景／重複候補＝赤太字（別プロパティなので両立する）。
  var rules = [];

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($' + idL + '2<>"", $' + stL + '2<>"確認済")')
    .setBackground("#FFF2CC")
    .setRanges([range]).build());

  if (noteCol >= 0) {
    var noL = colLetter_(noteCol + 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=REGEXMATCH(TO_TEXT($' + noL + '2), "dup_of")')
      .setBold(true)
      .setFontColor("#CC0000")
      .setRanges([range]).build());
  }

  sh.setConditionalFormatRules(rules);
}

/** 1-based 列番号 → A1 列文字。 */
function colLetter_(n) {
  var s = "";
  while (n > 0) {
    var m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ════════════════════════════════════════════════════════════════
//  メンバー編集モード（自己修正可＋編集で必ず再審査）
// ════════════════════════════════════════════════════════════════
// 設計: メンバーに DB の編集権を渡しても安全になるよう、
//   1) ヘッダ行とメタ列（record_id/status/... ）を保護してオーナーのみ編集可に。
//   2) installable な onEdit トリガで、メンバーがデータ列を編集したら
//      その行の status を「未確認」に戻し note に "edited" を付ける。
//      → 編集も必ずキュレーターの「未確認→確認済」ゲートを通る。
// 注意: シート単位の共有のため、他メンバーの行の編集・行削除までは技術的に防げない
//       （少人数・信頼前提の運用を想定）。メンバーには「閲覧＋自分の行のみ修正」を周知する。

/** メニュー: 保護を設定し、編集→未確認トリガを設置する。 */
function setupMemberEditing() {
  installEditRevertTrigger_();
  protectMetaAllTabs();
  toast_("メンバー編集を有効化しました（ヘッダ・メタ列を保護／編集で未確認へ戻す）");
}

/** 全 record タブのヘッダ行とメタ列を保護（編集はオーナーのみ）。 */
function protectMetaAllTabs() {
  var ss = SpreadsheetApp.getActive();
  var me = Session.getEffectiveUser();
  Object.keys(TAB_TYPE).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) protectSheetMeta_(sh, me);
  });
}

var PROTECT_TAG = "業績DB:lock";  // 当スクリプトが付けた保護の目印（再設定時に作り直す）。

/** 1 タブのヘッダ行＋メタ各列を保護する（既存の当スクリプト保護は作り直す）。 */
function protectSheetMeta_(sh, me) {
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach(function (p) {
    if (p.getDescription() === PROTECT_TAG) p.remove();
  });
  var maxRows = sh.getMaxRows();
  var lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  // ヘッダ行（列名）を保護。
  protectRange_(sh.getRange(1, 1, 1, lastCol), me);
  // メタ列を（将来追記される行も含め）列全体で保護。
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  META_FIELDS_LOCK.forEach(function (name) {
    for (var i = 0; i < header.length; i++) {
      if (String(header[i]).trim() === name && maxRows >= 2) {
        protectRange_(sh.getRange(2, i + 1, maxRows - 1, 1), me);
      }
    }
  });
}

/** 範囲を保護し、編集者を me のみにする。 */
function protectRange_(range, me) {
  var p = range.protect().setDescription(PROTECT_TAG);
  p.removeEditors(p.getEditors());
  if (p.canDomainEdit()) p.setDomainEdition(false);
  p.addEditor(me);
}

/** onEdit トリガ（onEditRevert）を重複なく設置する。 */
function installEditRevertTrigger_() {
  var ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "onEditRevert") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("onEditRevert").forSpreadsheet(ss).onEdit().create();
}

/**
 * installable onEdit トリガ本体（オーナー権限で実行）。
 * record タブのデータ列が編集されたら、その行の status を「未確認」へ戻し、
 * note に "edited" を付ける（メタ列だけの編集・空行は対象外）。
 */
function onEditRevert(e) {
  if (!e || !e.range) return;
  var sh = e.range.getSheet();
  if (!TAB_TYPE[sh.getName()]) return;          // record タブのみ
  var lastCol = sh.getLastColumn();
  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var col = {};                                  // ヘッダ名 → 1-based 列番号
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i + 1;
  if (!col.status) return;

  // メタ列だけの編集（status/note の自動更新を含む）は無視 → 無限ループ防止。
  var metaCols = {};
  META_FIELDS_LOCK.forEach(function (n) { if (col[n]) metaCols[col[n]] = true; });
  var c0 = e.range.getColumn(), nc = e.range.getNumColumns();
  var dataEdited = false;
  for (var c = c0; c < c0 + nc; c++) if (!metaCols[c]) dataEdited = true;
  if (!dataEdited) return;

  var r0 = e.range.getRow(), nr = e.range.getNumRows();
  for (var r = Math.max(r0, 2); r < r0 + nr; r++) {
    var rid = col.record_id ? String(sh.getRange(r, col.record_id).getValue()).trim() : "x";
    if (!rid) continue;                          // 空行（record_id なし）は対象外
    sh.getRange(r, col.status).setValue(APP_STATUS_NEW);
    if (col.note) {
      var note = String(sh.getRange(r, col.note).getValue() || "");
      if (note.indexOf("edited") < 0) {
        sh.getRange(r, col.note).setValue(note ? note + "; edited" : "edited");
      }
    }
  }
}

// ── 共通ヘルパ ───────────────────────────────────────────────
function headerCol_(sh, name) {
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  for (var i = 0; i < header.length; i++) {
    if (String(header[i]).trim() === name) return i;
  }
  return -1;
}

/** 選択範囲のデータ行（ヘッダ除く）に対して fn(rowIndex) を呼ぶ。 */
function eachSelectedDataRow_(sh, fn) {
  var rl = sh.getActiveRangeList();
  var ranges = rl ? rl.getRanges() : [sh.getActiveRange()];
  ranges.forEach(function (rg) {
    var start = rg.getRow(), num = rg.getNumRows();
    for (var r = start; r < start + num; r++) {
      if (r >= 2) fn(r);
    }
  });
}

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

function fetchCrossref_(doi) {
  try {
    var resp = UrlFetchApp.fetch("https://api.crossref.org/works/" + encodeURIComponent(doi),
                                 {muteHttpExceptions: true, followRedirects: true});
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText()).message || null;
  } catch (err) {
    return null;
  }
}

/** CrossRef メッセージで row の空セルを埋める。埋めたら true。 */
function fillRowFromCrossref_(row, col, type, msg) {
  function first(a) { return (a && a.length) ? a[0] : ""; }
  var changed = false;
  function setIfEmpty(name, v) {
    if (v && col[name] != null && !String(row[col[name]] || "").trim()) {
      row[col[name]] = v;
      changed = true;
    }
  }
  setIfEmpty(type === "book" ? "book_title_en" : "title_en", first(msg.title));
  setIfEmpty("journal_en", first(msg["container-title"]));
  setIfEmpty("journal_abbr_en", first(msg["short-container-title"]));
  setIfEmpty("volume", msg.volume || "");
  setIfEmpty("issue", msg.issue || "");
  setIfEmpty("pages", msg.page || "");
  var dp = msg["published-print"] || msg["published-online"] || msg["issued"];
  if (dp && dp["date-parts"] && dp["date-parts"][0]) {
    var p = dp["date-parts"][0];
    var pad = function (n) { n = String(n); return n.length < 2 ? "0" + n : n; };
    setIfEmpty("date", p[0] + "/" + pad(p[1] || 1) + "/" + pad(p[2] || 1));
  }
  return changed;
}

function toast_(msg) {
  SpreadsheetApp.getActive().toast(msg, "業績DB", 5);
}

// ════════════════════════════════════════════════════════════════
//  一括下書き（貼り付け → 表に展開 → 編集 → 取り込み）
// ════════════════════════════════════════════════════════════════
var STAGING_SHEET = "一括下書き";
var STAGING_TABLE_COL = 3;   // 解析後テーブルの開始列（C）
var STAGING_RAW_HEADER_ROW = 3;
var STAGING_DATA_ROW = 4;

// 種別ラベル ↔ 内部キー（タブ名は TAB_TYPE の逆引き）。
var TYPE_LABELS = {
  paper: "原著論文・英文総説", book: "著書・和文総説", presentation: "発表・講演",
  award: "受賞", outreach: "アウトリーチ", publicity: "広報・パブリシティ"
};
var TYPE_TAB = {paper: "Original Papers", book: "Books", presentation: "presentations",
                award: "Awards", outreach: "Outreach", publicity: "Publicity"};
var TYPE_PREFIX = {paper: "PAP", book: "BK", presentation: "PRE",
                   award: "AWD", outreach: "OUT", publicity: "PUB"};

// Canonical 列（v2: 二ヶ国語は _ja/_en）。schema.py と一致。
var CANON_FIELDS = {
  paper: ["date", "category", "peer_reviewed", "authors", "title_ja", "title_en",
          "journal_ja", "journal_en", "journal_abbr_ja", "journal_abbr_en",
          "volume", "issue", "pages", "doi"],
  book: ["date", "international", "peer_reviewed", "authors", "review_title_ja",
         "review_title_en", "book_title_ja", "book_title_en", "chapter", "editor",
         "volume", "issue", "pages", "publisher", "doi", "issn", "isbn"],
  presentation: ["date", "scope", "title_ja", "title_en", "authors", "conference_ja",
                 "conference_en", "symposium_ja", "symposium_en", "invited", "venue",
                 "presentation_type"],
  award: ["date", "scope", "authors", "title_ja", "title_en", "awarded_study", "organization"],
  outreach: ["date", "scope", "authors", "title_ja", "title_en", "venue"],
  publicity: ["date", "media_type", "media_name", "authors", "title_ja", "title_en", "link"]
};
// 選択肢（プルダウン）を持つフィールド。
var FIELD_CHOICES = {
  category: ["原著論文", "英文総説"], peer_reviewed: ["査読あり", "査読なし"],
  international: ["国内", "国際"], scope: ["国内", "国際"],
  invited: ["招待あり", "招待なし"], presentation_type: ["口頭", "ポスター", "口頭＆ポスター"],
  media_type: ["新聞", "TV", "Web", "雑誌", "その他"]
};

// 解析用（publication_form.gs と同一ロジック）。
var BILINGUAL_BASES = ["title", "journal", "journal_abbr", "book_title",
                       "review_title", "conference", "symposium"];
var PASTE_TITLE_FIELD = {paper: "title", book: "review_title", presentation: "title",
                         award: "title", outreach: "title", publicity: "title"};
var PASTE_VENUE_FIELD = {paper: "journal", book: "book_title", presentation: "conference",
                         award: "organization", outreach: "venue", publicity: "media_name"};
var EN_MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};

function labelToTypeKey_(label) {
  for (var k in TYPE_LABELS) { if (TYPE_LABELS[k] === label) return k; }
  return null;
}
function hasCjk_(s) { return /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(String(s || "")); }

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

/** 一括下書きシートを作成（種別ドロップダウン＋貼り付け欄）。 */
function stagingSetup() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(STAGING_SHEET) || ss.insertSheet(STAGING_SHEET);
  sh.clear();
  sh.getRange("A1").setValue("種別").setFontWeight("bold");
  var labels = Object.keys(TYPE_LABELS).map(function (k) { return TYPE_LABELS[k]; });
  sh.getRange("B1").setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(labels, true).build());
  sh.getRange("B1").setValue(TYPE_LABELS.presentation);
  sh.getRange("A2").setValue(
    "使い方: B1で種別を選び、A4以降に researchmap 等の生テキストを貼り付け → "
    + "メニュー「一括下書き: 表に展開」→ 右(C列〜)の表を確認・修正 → 「一括下書き: 取り込む」");
  sh.getRange("A3").setValue("生テキスト（貼り付け・1行=1行／末尾に日付がある行が区切り）")
    .setFontWeight("bold");
  sh.setColumnWidth(1, 380);
  sh.getRange("B1").activate();
  toast_("一括下書きシートを準備しました。B1で種別→A4に貼り付け→「表に展開」。");
}

/** 生テキストを解析して右側に編集可能な表として展開。 */
function stagingExpand() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(STAGING_SHEET);
  if (!sh) { toast_("先に「一括下書き: シートを準備」を実行してください"); return; }
  var rtype = labelToTypeKey_(String(sh.getRange("B1").getValue()).trim());
  if (!rtype) { toast_("B1 で種別を選んでください"); return; }

  var last = sh.getLastRow();
  var raw = last >= STAGING_DATA_ROW
    ? sh.getRange(STAGING_DATA_ROW, 1, last - STAGING_DATA_ROW + 1, 1).getValues()
        .map(function (r) { return r[0]; }).join("\n")
    : "";
  var recs = parseRecords_(raw, rtype);
  recs.forEach(ensureBilingualValues_);

  // 右側テーブル領域をクリアして書き直す。
  var fields = CANON_FIELDS[rtype];
  var maxCols = sh.getMaxColumns();
  if (maxCols >= STAGING_TABLE_COL) {
    sh.getRange(STAGING_RAW_HEADER_ROW, STAGING_TABLE_COL,
                sh.getMaxRows() - STAGING_RAW_HEADER_ROW + 1, maxCols - STAGING_TABLE_COL + 1)
      .clear();
  }
  sh.getRange(STAGING_RAW_HEADER_ROW, STAGING_TABLE_COL, 1, fields.length)
    .setValues([fields]).setFontWeight("bold").setBackground("#DDEBF7");
  if (recs.length) {
    var rows = recs.map(function (rec) {
      return fields.map(function (f) { return rec[f] != null ? rec[f] : ""; });
    });
    sh.getRange(STAGING_DATA_ROW, STAGING_TABLE_COL, rows.length, fields.length).setValues(rows);
  }
  // 選択肢フィールドにプルダウンを設定。
  fields.forEach(function (f, i) {
    if (FIELD_CHOICES[f]) {
      sh.getRange(STAGING_DATA_ROW, STAGING_TABLE_COL + i, Math.max(recs.length, 50), 1)
        .setDataValidation(
          SpreadsheetApp.newDataValidation().requireValueInList(FIELD_CHOICES[f], true).build());
    }
  });
  toast_(recs.length + " 件を表に展開しました（" + TYPE_LABELS[rtype] + "）。確認・修正して「取り込む」。");
}

/** 右側テーブルの内容を該当タブへ status=未確認 で取り込み、下書きをクリア。 */
function stagingImport() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(STAGING_SHEET);
  if (!sh) { toast_("先に「一括下書き: シートを準備」を実行してください"); return; }
  var rtype = labelToTypeKey_(String(sh.getRange("B1").getValue()).trim());
  if (!rtype) { toast_("B1 で種別を選んでください"); return; }

  var fields = CANON_FIELDS[rtype];
  var last = sh.getLastRow();
  if (last < STAGING_DATA_ROW) { toast_("表が空です。先に「表に展開」を。"); return; }
  var table = sh.getRange(STAGING_DATA_ROW, STAGING_TABLE_COL,
                          last - STAGING_DATA_ROW + 1, fields.length).getValues();
  var recs = [];
  table.forEach(function (row) {
    var rec = {};
    var any = false;
    fields.forEach(function (f, i) {
      var v = row[i];
      if (v !== "" && v != null) { rec[f] = v; any = true; }
    });
    if (any) recs.push(rec);
  });
  if (!recs.length) { toast_("取り込む行がありません"); return; }

  var added = appendBatch_(ss, rtype, recs, "staging");

  // 取り込んだら下書き（生テキスト＋表）をクリア。
  sh.getRange(STAGING_DATA_ROW, 1, sh.getMaxRows() - STAGING_DATA_ROW + 1, sh.getMaxColumns())
    .clear();
  toast_(added + " 件を「" + TYPE_TAB[rtype] + "」へ取り込みました（status=未確認）。");
}

/** recs（field→値）を該当タブへ追記。重複は note=dup_of でフラグ。追記件数を返す。 */
function appendBatch_(ss, rtype, recs, source) {
  var sheet = ss.getSheetByName(TYPE_TAB[rtype]);
  if (!sheet) { toast_("タブが見つかりません: " + TYPE_TAB[rtype]); return 0; }
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  var titleOnly = (rtype === "paper" || rtype === "book");

  // 既存行のキー→record_id マップ。
  var keyToId = {};
  var last = sheet.getLastRow();
  if (last >= 2) {
    var ex = sheet.getRange(2, 1, last - 1, header.length).getValues();
    ex.forEach(function (row) {
      var c = function (n) { return n in col ? row[col[n]] : ""; };
      var t = String(c("title_ja") || c("title_en") || c("book_title_ja") || c("book_title_en") || "").trim();
      var rid = String(c("record_id") || "").trim();
      dupKeysOf_(c("doi"), c("date"), t, titleOnly).forEach(function (k) { if (!keyToId[k]) keyToId[k] = rid; });
    });
  }

  var rows = [];
  recs.forEach(function (rec) {
    var t = String(rec.title_ja || rec.title_en || rec.book_title_ja || rec.book_title_en || "").trim();
    var keys = dupKeysOf_(rec.doi, rec.date, t, titleOnly);
    var dupId = "";
    for (var j = 0; j < keys.length; j++) { if (keyToId[keys[j]]) { dupId = keyToId[keys[j]]; break; } }
    var rid = TYPE_PREFIX[rtype] + "-" + ("000" + (sheet.getLastRow() + rows.length)).slice(-4);
    var meta = {
      record_id: rid, status: APP_STATUS_NEW, submitter: "", source: source,
      created_at: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm:ss"),
      note: dupId ? ("dup_of=" + dupId) : ""
    };
    rows.push(header.map(function (h) {
      var key = String(h).trim();
      if (key in meta) return meta[key];
      return (key in rec) ? rec[key] : "";
    }));
    keys.forEach(function (k) { if (!keyToId[k]) keyToId[k] = rid; });
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  }
  return rows.length;
}
