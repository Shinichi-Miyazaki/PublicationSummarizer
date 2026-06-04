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
    .addItem("このタブの重複を再チェック", "recheckDuplicates")
    .addSeparator()
    .addItem("色分けを設定（全タブ）", "highlightAllTabs")
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

/** アクティブタブ内の重複（DOI/日付+タイトル）を再チェックし、後発行に note=dup_of を付ける。 */
function recheckDuplicates() {
  var sh = SpreadsheetApp.getActiveSheet();
  if (!TAB_TYPE[sh.getName()]) { toast_("record タブで実行してください"); return; }
  var last = sh.getLastRow();
  if (last < 3) { toast_("重複なし"); return; }
  var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  var data = sh.getRange(2, 1, last - 1, header.length).getValues();
  var seenDoi = {}, seenDt = {}, flagged = 0;
  for (var r = 0; r < data.length; r++) {
    var row = data[r];
    function c(name) { return name in col ? row[col[name]] : ""; }
    var t = String(c("title_ja") || c("title_en") || c("book_title_ja") || c("book_title_en") || "").trim();
    var doi = doiKeyOf_(c("doi"));
    var dt = dtKeyOf_(c("date"), t);
    var first = (doi && seenDoi[doi]) || seenDt[dt] || "";  // 一致した既存の record_id
    if (first) {
      if (col.note != null) {
        var note = String(row[col.note] || "");
        var tag = "dup_of=" + first;
        if (note.indexOf(tag) < 0) {
          row[col.note] = note ? note + "; " + tag : tag;
          sh.getRange(r + 2, col.note + 1).setValue(row[col.note]);
          flagged++;
        }
      }
    } else {
      var rid = String(c("record_id") || "").trim() || ("行" + (r + 2));
      if (doi) seenDoi[doi] = rid;
      seenDt[dt] = rid;
    }
  }
  toast_(flagged + " 件の重複候補に印を付けました");
}

/** 全 record タブに、未確認＝黄／重複候補＝赤 の条件付き書式を設定する。 */
function highlightAllTabs() {
  var ss = SpreadsheetApp.getActive();
  var n = 0;
  Object.keys(TAB_TYPE).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (sh) { applyHighlighting_(sh); n++; }
  });
  toast_(n + " タブに色分けを設定しました（未確認=黄, 重複候補=赤）");
}

/** 1 タブに条件付き書式を設定（status≠確認済→黄, note に dup_of→赤）。 */
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

  // このタブの条件付き書式は作り直す（黄=未確認, 赤=重複候補）。
  var rules = [];

  // 重複候補（note に dup_of）＝赤。先に評価されるよう先頭に。
  if (noteCol >= 0) {
    var noL = colLetter_(noteCol + 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=AND($' + idL + '2<>"", REGEXMATCH(TO_TEXT($' + noL + '2),"dup_of"))')
      .setBackground("#F4CCCC")  // 薄い赤
      .setRanges([range]).build());
  }
  // 未確認（status が「確認済」でない、かつ行が実在）＝黄。
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=AND($' + idL + '2<>"", $' + stL + '2<>"確認済")')
    .setBackground("#FFF2CC")  // 薄い黄
    .setRanges([range]).build());

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
function doiKeyOf_(doi) {
  doi = String(doi || "").trim().toLowerCase();
  return doi ? ("doi:" + doi) : "";
}
function dtKeyOf_(date, title) {
  return "dt:" + ymOf_(date) + "|" + String(title || "").trim().toLowerCase().slice(0, 40);
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
