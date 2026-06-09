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
 *   - 選択行を承認(確認済) / 未確認に戻す  … status を切り替える
 *   - ★ まとめて点検                      … 全タブの重複・欠損を再判定し色分け＋「点検レポート」シートに一覧
 *   - 選択行を補完                        … 論文=DOI/タイトル検索→CrossRef、書籍=ISBN→OpenLibrary
 *   - メンバー編集を有効化                  … 列・メタ保護＋編集で未確認に戻す（メンバー自己修正）
 *
 * 注意: 補完・承認は record タブ（Original Papers / presentations 等）で行を選択してから実行する。
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
    .addItem("★ まとめて点検（重複・欠損・色分け → レポート）", "runAllChecks")
    .addItem("選択行を補完（DOI・タイトル・ISBN 自動）", "enrichSelected")
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

/**
 * 選択行を自動補完（論文・書籍のみ）。タブと各行の内容に応じて使い分ける:
 *   論文 … DOI があれば CrossRef、無ければタイトル（＋著者）で DOI を特定してから CrossRef。
 *   書籍 … DOI があれば CrossRef、ISBN があれば OpenLibrary で書名・出版社・出版日。
 */
function enrichSelected() {
  var sh = SpreadsheetApp.getActiveSheet();
  var type = TAB_TYPE[sh.getName()];
  if (type !== "paper" && type !== "book") { toast_("自動補完は論文・書籍タブのみ対応です"); return; }
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  var n = 0;
  eachSelectedDataRow_(sh, function (r) {
    var rowRange = sh.getRange(r, 1, 1, header.length);
    var row = rowRange.getValues()[0];
    if (enrichRow_(row, col, type)) { rowRange.setValues([row]); n++; }
  });
  toast_(n + " 行を補完しました");
}

/** 1 行を種別に応じて補完（DOI→CrossRef、論文は不足時タイトル検索、書籍は ISBN）。埋めたら true。 */
function enrichRow_(row, col, type) {
  var changed = false;
  function addNote(tag) {
    if (col.note == null) return;
    var note = String(row[col.note] || "");
    if (note.indexOf(tag) < 0) row[col.note] = note ? note + "; " + tag : tag;
  }
  var doi = ("doi" in col) ? String(row[col.doi] || "").trim() : "";
  // 論文で DOI 未入力 → タイトル（＋著者）で DOI を特定。
  if (type === "paper" && !doi && col.doi != null) {
    var title = String(row[col.title_en] || row[col.title_ja] || "").trim();
    var authors = String(col.authors != null ? row[col.authors] : "").trim();
    var found = resolveDoiByTitle_(title, authors);
    if (found) { row[col.doi] = found; doi = found; changed = true; addNote("crossref-title"); }
  }
  // DOI があれば CrossRef で空欄補完。
  if (doi) {
    var msg = fetchCrossref_(doi);
    if (msg && fillRowFromCrossref_(row, col, type, msg)) { changed = true; addNote("crossref"); }
  }
  // 書籍は ISBN からも補完。
  if (type === "book" && "isbn" in col) {
    var isbn = String(row[col.isbn] || "").trim();
    if (isbn) {
      var book = fetchBookByIsbn_(isbn);
      if (book && fillRowFromBook_(row, col, book)) { changed = true; addNote("openlibrary"); }
    }
  }
  return changed;
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

/** OpenLibrary から ISBN で書誌を取得（なければ null）。 */
function fetchBookByIsbn_(isbn) {
  var key = String(isbn || "").replace(/[^0-9Xx]/g, "");
  if (key.length < 10) return null;
  try {
    var url = "https://openlibrary.org/api/books?bibkeys=ISBN:" + key + "&format=json&jscmd=data";
    var resp = UrlFetchApp.fetch(url, {muteHttpExceptions: true, followRedirects: true});
    if (resp.getResponseCode() !== 200) return null;
    return JSON.parse(resp.getContentText())["ISBN:" + key] || null;
  } catch (err) {
    return null;
  }
}

/** OpenLibrary の書誌で row の空セル（書名・出版社・出版日）を埋める。埋めたら true。 */
function fillRowFromBook_(row, col, book) {
  var changed = false;
  function setIfEmpty(name, v) {
    if (v && col[name] != null && !String(row[col[name]] || "").trim()) {
      row[col[name]] = v; changed = true;
    }
  }
  var title = book.title || "";
  if (title) setIfEmpty(hasCjk_(title) ? "book_title_ja" : "book_title_en", title);
  var pub = (book.publishers && book.publishers.length) ? book.publishers[0].name : "";
  setIfEmpty("publisher", pub);
  setIfEmpty("date", parseLooseDate_(book.publish_date));
  return changed;
}

/** "2015" / "March 2015" / "2015-03-01" 等を "YYYY[/M[/D]]" へ正規化（不明は ""）。 */
function parseLooseDate_(s) {
  s = String(s || "");
  var ym = /(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/.exec(s);
  if (ym) return ym[1] + "/" + (+ym[2]) + (ym[3] ? ("/" + (+ym[3])) : "");
  var en = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})/i.exec(s);
  if (en) return en[2] + "/" + EN_MONTHS[en[1].toLowerCase().slice(0, 3)];
  var y = /(\d{4})/.exec(s);
  return y ? y[1] : "";
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

/** 行の代表タイトル（title_ja/en・book_title_ja/en の順で最初に埋まっているもの）。 */
function rowTitle_(row, col) {
  var keys = ["title_ja", "title_en", "book_title_ja", "book_title_en"];
  for (var i = 0; i < keys.length; i++) {
    if (col[keys[i]] != null) {
      var v = String(row[col[keys[i]]] || "").trim();
      if (v) return v;
    }
  }
  return "";
}

// ── 欠損値チェック ───────────────────────────────────────────────
// 種別ごとの必須グループ（各グループは「いずれか 1 列が埋まっていれば OK」）。
// publication_form.gs の required:true 設問と整合（二ヶ国語は _ja/_en のどちらかで可）。
var REQUIRED_GROUPS = {
  paper: [["date"], ["category"], ["peer_reviewed"], ["authors"],
          ["title_ja", "title_en"], ["journal_ja", "journal_en"]],
  book: [["date"], ["international"], ["authors"], ["book_title_ja", "book_title_en"]],
  presentation: [["date"], ["scope"], ["title_ja", "title_en"], ["authors"],
                 ["conference_ja", "conference_en"]],
  award: [["date"], ["scope"], ["authors"], ["title_ja", "title_en"]],
  outreach: [["date"], ["scope"], ["authors"], ["title_ja", "title_en"]],
  publicity: [["date"], ["media_type"], ["media_name"], ["authors"], ["title_ja", "title_en"]]
};

// 論理フィールド（base 名）→ 日本語ラベル（レポート表示用）。
var FIELD_LABELS = {
  date: "日付", category: "区分", peer_reviewed: "査読", international: "国内/国際",
  scope: "国内/国際", authors: "著者", title: "タイトル", journal: "雑誌名",
  journal_abbr: "略誌名", volume: "巻", issue: "号", pages: "ページ", doi: "DOI",
  review_title: "章・総説タイトル", book_title: "書名", chapter: "章", editor: "編者",
  publisher: "出版社", issn: "ISSN", isbn: "ISBN", conference: "学会・研究会名",
  symposium: "シンポジウム", invited: "招待", venue: "開催地", presentation_type: "発表形式",
  awarded_study: "受賞対象", organization: "授与団体", media_type: "媒体種別",
  media_name: "媒体名", link: "リンク"
};
function fieldLabel_(base) { return FIELD_LABELS[base] || base; }

/** その行に欠けている必須項目（base 名）の配列を返す。 */
function missingFieldsOf_(type, cell) {
  var groups = REQUIRED_GROUPS[type] || [];
  var miss = [];
  groups.forEach(function (g) {
    var ok = g.some(function (c) { return String(cell(c) || "").trim(); });
    if (!ok) miss.push(g[0].replace(/_(ja|en)$/, ""));
  });
  return miss;
}

/** note 内の "key=..." トークンを置換（value 空なら除去）。他のタグ・手書きメモは保持。 */
function setNoteTag_(note, key, value) {
  var parts = String(note || "").split(/;\s*/).filter(function (p) {
    return p && p !== key && p.indexOf(key + "=") !== 0;
  });
  if (value) parts.push(key + "=" + value);
  return parts.join("; ");
}

/** 1 タブの欠損を再判定し note の missing= を更新。欠損のある行数を返す（note 列なしは -1）。 */
function recheckMissingSheet_(sh) {
  var type = TAB_TYPE[sh.getName()];
  var last = sh.getLastRow();
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  if (col.note == null) return -1;
  if (last < 2) return 0;
  var data = sh.getRange(2, 1, last - 1, header.length).getValues();
  var flagged = 0;
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    var cell = function (name) { return name in col ? row[col[name]] : ""; };
    if (!String(cell("record_id") || "").trim()) continue;  // 空行は対象外
    var miss = missingFieldsOf_(type, cell);
    var newNote = setNoteTag_(row[col.note], "missing", miss.join("|"));
    if (newNote !== String(row[col.note] || "")) {
      sh.getRange(r + 2, col.note + 1).setValue(newNote);
    }
    if (miss.length) flagged++;
  }
  return flagged;
}

var REPORT_SHEET = "点検レポート";

/**
 * ワンクリック総点検: 全 record タブで「重複・欠損の再判定 → 色分け」を行い、
 * 問題行を 1 枚の「点検レポート」シートへ一覧出力する（チェック者はこれだけ見ればよい）。
 */
function runAllChecks() {
  var ss = SpreadsheetApp.getActive();
  var report = [];  // [タブ, record_id, 種類, 詳細, タイトル]
  var dupTotal = 0, missTotal = 0, noNote = 0;
  Object.keys(TAB_TYPE).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    if (recheckSheet_(sh) === -1) { noNote++; return; }  // note 列なしはスキップ
    recheckMissingSheet_(sh);
    applyHighlighting_(sh);

    var last = sh.getLastRow();
    if (last < 2) return;
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    var col = {};
    for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
    var data = sh.getRange(2, 1, last - 1, header.length).getValues();
    // record_id → タイトル（重複の一致先タイトルを併記するため）。
    var titleById = {};
    data.forEach(function (row) {
      var rid = String(row[col.record_id] || "").trim();
      if (rid) titleById[rid] = rowTitle_(row, col);
    });
    var typeLabel = TYPE_LABELS[TAB_TYPE[name]] || name;
    data.forEach(function (row) {
      var rid = String(row[col.record_id] || "").trim();
      if (!rid) return;
      var note = String(col.note != null ? row[col.note] : "");
      var title = rowTitle_(row, col);
      var dm = /dup_of=([^;]+)/.exec(note);
      if (dm) {
        var tgt = dm[1].trim();
        report.push([typeLabel, rid, "重複", "既存「" + (titleById[tgt] || tgt) + "」(" + tgt + ") と重複の可能性", title]);
        dupTotal++;
      }
      var mm = /missing=([^;]+)/.exec(note);
      if (mm) {
        var ja = mm[1].trim().split("|").map(fieldLabel_).join("、");
        report.push([typeLabel, rid, "欠損", "未入力：" + ja, title]);
        missTotal++;
      }
    });
  });

  writeCheckReport_(ss, report);
  var msg = "点検完了：重複 " + dupTotal + " 件・欠損 " + missTotal + " 件。"
    + "『" + REPORT_SHEET + "』シートに一覧を出しました（色分けも更新）。";
  if (noNote) msg += "／note 列なし " + noNote + " タブはスキップ（v2 化が必要）";
  toast_(msg);
  if (report.length) {
    SpreadsheetApp.setActiveSheet(ss.getSheetByName(REPORT_SHEET));
  }
}

/** 点検結果を「点検レポート」シートへ書き出す（毎回作り直し）。 */
function writeCheckReport_(ss, rows) {
  var sh = ss.getSheetByName(REPORT_SHEET) || ss.insertSheet(REPORT_SHEET);
  sh.clear();
  var header = ["種別", "ID", "問題", "内容", "タイトル"];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight("bold");
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  } else {
    sh.getRange(2, 1).setValue("問題は見つかりませんでした 🎉");
  }
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, header.length);
}

/** 1 タブに条件付き書式を設定（欠損→橙背景, status≠確認済→黄背景, note に dup_of→赤太字）。 */
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

  // 背景は先に一致したルールが勝つ。欠損(橙)を未確認(黄)より優先。重複は赤太字(フォント)で両立。
  var rules = [];

  if (noteCol >= 0) {
    var noL = colLetter_(noteCol + 1);
    // 欠損あり＝橙背景（未確認の黄より優先して目立たせる）。
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=REGEXMATCH(TO_TEXT($' + noL + '2), "missing=")')
      .setBackground("#FCE5CD")
      .setRanges([range]).build());
  }

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($' + idL + '2<>"", $' + stL + '2<>"確認済")')
    .setBackground("#FFF2CC")
    .setRanges([range]).build());

  if (noteCol >= 0) {
    var noL2 = colLetter_(noteCol + 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=REGEXMATCH(TO_TEXT($' + noL2 + '2), "dup_of")')
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

// ── 共有の小ヘルパ／定数 ───────────────────────────────────────────
// 種別キー → 日本語ラベル（点検レポート等の表示に使う）。
var TYPE_LABELS = {
  paper: "原著論文・英文総説", book: "著書・和文総説", presentation: "発表・講演",
  award: "受賞", outreach: "アウトリーチ", publicity: "広報・パブリシティ"
};
var EN_MONTHS = {jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12};
function hasCjk_(s) { return /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(String(s || "")); }
