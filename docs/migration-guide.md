# 移行・セットアップ手順書（初心者向け）

このアプリは、研究業績をまとめたスプレッドシート（DB）を読み込んで、著者・年度・種別で絞り込み、
科研費などの書式に整えてくれます。この手順書では、

1. **今ある業績データ**を、新しいきれいな DB（**Canonical 形式**）に作り替える
2. それを **Google スプレッドシート**として置く
3. **アプリを起動**して読み込む

までを、はじめての人でも迷わないように **1 ステップずつ** 説明します。
専門用語はその都度かみくだいて書きます。所要時間はおおむね 20〜30 分です。

> 💡 **用語**
> - **DB**：データベース。ここでは「業績をためておくスプレッドシート」のこと。
> - **Canonical（カノニカル）形式**：このアプリ用に整えた、列名がきれいで崩れにくい新しい表の形。
> - **PowerShell**：Windows の黒い画面（コマンドを打つ場所）。

---

## 0. 準備（最初に一度だけ）

### 0-1. プロジェクトのフォルダで PowerShell を開く
1. エクスプローラーで `C:\Users\Shinichi\PycharmProjects\PublicationSummarizer` を開く。
2. フォルダの**何もないところで `Shift` を押しながら右クリック** → **「PowerShell ウィンドウをここで開く」**（または「ターミナルで開く」）を選ぶ。
3. 黒い（または青い）画面が出て、行頭にこのフォルダのパスが表示されていれば OK。

> 以降のコマンドは、この PowerShell に**1 行ずつコピーして貼り付け、`Enter`** で実行します。
> 貼り付けは、画面内で**右クリック**するだけのことが多いです。

### 0-2. 必要なソフトが入っているか確認
次の 1 行を貼り付けて `Enter`：

```powershell
.\.venv\Scripts\python.exe -c "import pandas, openpyxl, rapidfuzz, requests, streamlit; print('準備OK')"
```

- `準備OK` と表示されれば次へ進めます。
- エラーが出たら、先に次を実行して部品をインストールします：
  ```powershell
  .\.venv\Scripts\python.exe -m pip install -r requirements.txt
  ```

---

## 1. 今のデータを「きれいな DB」に変換する

今の（列がそろっていない）スプレッドシートから、きれいな `canonical.xlsx` というファイルを作ります。
**元データは一切書き換えません**（読み取るだけ）。安心して実行してください。

PowerShell に次を貼り付けて `Enter`：

```powershell
.\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from legacy --out canonical.xlsx
```

うまくいくと、こんな表示が出ます（件数は実際のデータによります）：

```
[完了] canonical.xlsx へ 116 件を取り込みました（status=確認済）
  - Original Papers: +5
  - Books: +8
  - presentations: +66
  - Awards: +8
  - Outreach: +15
  - Publicity: +14
```

> ⚠️ 日本語が文字化けして表示されることがありますが、**ファイルは正しく作られています**。気にしなくて大丈夫です。
> ✅ フォルダに `canonical.xlsx` というファイルが新しくできていれば成功です。

<details>
<summary>うまくいかないとき（クリックで開く）</summary>

- **`FETCH_FAIL` や通信エラー**：元のスプレッドシートが「リンクを知っている全員が閲覧可」になっているか確認してください（共有設定）。
- すでに手元に元データの xlsx ファイルがある場合は、ネットに取りに行かず、そのファイルから作れます：
  ```powershell
  .\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from legacy --src もとのファイル.xlsx --out canonical.xlsx
  ```
</details>

---

## 2. 変換結果が正しいか確認する（任意だが推奨）

作った `canonical.xlsx` をアプリのロジックで読み、エラーが無いか自動チェックします：

```powershell
.\.venv\Scripts\python.exe tests\verify.py canonical.xlsx
```

最後に `RESULT: 31 passed, 0 failed`（passed の数は増減します）と出て、
**failed が 0** であれば OK です。途中に各種別の件数も表示されるので、手順 1 の件数と一致するか目で確認できます。

---

## 3. きれいな DB を Google スプレッドシートとして置く

`canonical.xlsx` は今あなたのパソコンの中にあります。これをアプリが読めるよう、Google 上に置きます。

### 3-1. Google ドライブにアップロードする
1. ブラウザで <https://drive.google.com> を開く（業績管理に使う Google アカウントでログイン）。
2. 左上の **「+ 新規」** → **「ファイルのアップロード」** をクリック。
3. プロジェクトフォルダの **`canonical.xlsx`** を選ぶ。
4. 右下にアップロード完了の表示が出るまで待つ。

### 3-2. Google スプレッドシート形式に変換する
アップロードしたままだと「Excel ファイル」のままなので、Google スプレッド-シートに変換します。

1. ドライブ上の **`canonical.xlsx`** を**ダブルクリック**して開く（プレビューが出ます）。
2. 画面上部の **「Google スプレッドシートで開く」** をクリック。
3. 開いたら、メニューの **ファイル → Google スプレッドシートとして保存**（環境により自動でコピーが作られます）。
4. これで、`canonical`（拡張子なし）という名前の **本物の Google スプレッドシート**ができます。以降はこれを DB として使います。

> タブ（シート下部の見出し）に `Original Papers` / `Books` / `presentations` / `Awards` / `Outreach` / `Publicity` /
> `Input confirmation` が並んでいれば正しく変換できています。

### 3-3. 共有設定を「閲覧可」にする
アプリはパスワード無しでこの DB を読みます。そのために共有を開けます。

1. 右上の **「共有」** をクリック。
2. 下の **「一般的なアクセス」** を **「リンクを知っている全員」** に変更。
3. 右側の役割は **「閲覧者」** のままで OK（編集者にしない）。
4. **「リンクをコピー」** を押して、リンクを控えておく。

> 🔒 学外に出したくない場合は、「リンクを知っている全員」にせず、特定の人だけに共有しても使えます
> （その場合はアプリ側でログインが必要になることがあります）。

### 3-4. スプレッドシートの ID を確認する
コピーしたリンクは次のような形です：

```
https://docs.google.com/spreadsheets/d/【ここが ID】/edit#gid=0
```

`/d/` と `/edit` の間の長い文字列が **スプレッドシート ID** です。次の手順で使います
（リンク全体をそのまま貼ってもアプリは ID を取り出せます）。

---

## 4. アプリを起動して読み込む

### 4-1. アプリを起動する
PowerShell に次を貼り付けて `Enter`：

```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```

しばらくすると自動でブラウザが開きます（開かなければ、画面に出る `http://localhost:8501` をブラウザに貼り付け）。

### 4-2. 読み込む DB を指定する
1. 画面左の**サイドバー**にある「スプレッドシートの URL または ID」欄に、
   手順 3-3 でコピーした**リンク**（または手順 3-4 の **ID**）を貼り付ける。
2. 6 つの種別と件数が表示され、著者・年度・種別での絞り込みや、科研費などの書式プレビューができれば**成功**です 🎉

### 4-3.（任意）毎回その DB を既定で開くようにする
毎回リンクを貼るのが面倒なら、既定の読み込み先を新しい DB に変えられます。

1. ファイル `publication_summarizer\loader.py` を開く。
2. 次の 1 行を探す：
   ```python
   DEFAULT_SHEET_ID = "1_7b_-6EsRNr6tW1naDj8QJ5M0espE5Wv"
   ```
3. ダブルクォートの中身を、手順 3-4 の**新しい ID** に書き換えて保存。
4. アプリを開き直すと、最初からその DB を読みます。

---

## 5. 今後の業績の追加方法

新しい DB は **列名がきれい**なので、追加が安全になりました。状況に応じて選べます。

### A. 1 件ずつ足す（少数のとき）
Google スプレッドシートで該当タブを開き、**いちばん下の行に直接入力**します。
- `status` 列に **`確認済`** と入れた行だけがアプリに表示されます（`未確認` や空欄は表示されません＝下書き扱い）。
- `record_id` は重複しない適当な値（例：`PAP-0006`）で構いません。

### B. 既にリストを持っている人を一気に足す（一括入力）
誰かが Excel/CSV で業績一覧を持っている場合、まとめて取り込めます。

1. 現在の Google スプレッドシートを **ファイル → ダウンロード → Microsoft Excel (.xlsx)** で
   `canonical.xlsx` として保存（プロジェクトフォルダへ）。
2. もらったリストを `papers.xlsx` などの名前でプロジェクトフォルダに置く。
3. PowerShell で取り込む（`--type` は種別。論文なら `paper`）：
   ```powershell
   .\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from xlsx --type paper --src papers.xlsx --append canonical.xlsx
   ```
   - 列の見出しが多少違っても自動で対応づけます。重複（同じ DOI など）は自動で除外します。
   - 取り込んだ行は **`status=未確認`** になります。
4. 更新した `canonical.xlsx` を、手順 3 と同じ要領でドライブに上げ直して反映します。
5. スプレッドシートで内容を確認し、問題なければ `status` を **`確認済`** に変えるとアプリに出ます。

> 種別キーワード：`paper`（論文）/ `book`（著書）/ `presentation`（発表）/ `award`（受賞）/
> `outreach`（アウトリーチ）/ `publicity`（広報）。CSV のときは `--from xlsx` を `--from csv` に変えます。

### C. フォームで集める（おすすめ・将来）
各メンバーに Google フォームで送ってもらい、自動でためる運用です。作り方は
[`docs/google-forms.md`](google-forms.md) を参照してください。

---

## 6. 困ったときは（よくある質問）

| 症状 | 原因と対処 |
|---|---|
| アプリに「データがありません」と出る | DB が Google スプレッドシート形式に**変換されていない**（Excel のまま）／共有が閲覧可になっていない／`status` 列が全部空。手順 3-2・3-3 と「`確認済`」を確認。 |
| 件数が思ったより少ない | `status` が `確認済` の行だけ表示されます。下書き（`未確認`）は意図的に隠れます。 |
| コマンドの日本語が文字化けする | 表示だけの問題で、ファイルは正常です。無視して OK。 |
| `python が見つからない` と出る | コマンド先頭の `.\.venv\Scripts\python.exe` を省略していないか確認。フォルダの中で PowerShell を開いているかも確認（手順 0-1）。 |
| 元のデータを壊してしまわないか不安 | 変換は**読み取りだけ**で、元シートは一切変更しません。新しいファイルを作るだけです。 |

---

## まとめ（早見表）

```powershell
# 1. 今のデータ → きれいな DB ファイルを作る
.\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from legacy --out canonical.xlsx

# 2. 確認（failed が 0 ならOK）
.\.venv\Scripts\python.exe tests\verify.py canonical.xlsx

# 3. canonical.xlsx を Google ドライブにアップ → スプレッドシートに変換 → 「リンクを知っている全員（閲覧者）」で共有

# 4. アプリ起動 → サイドバーにそのリンク/IDを貼る
.\.venv\Scripts\python.exe -m streamlit run app.py
```
