# 研究業績サマライザー

Google Spreadsheet（複数シートに分かれた研究業績）から、**著者・年度・業績種別**で絞り込み、
**提出先文書に応じた書式**（科研費がベース、提出先により編集可）で整形・プレビューする Streamlit Web アプリ。

## 特徴
- **認証不要**：スプレッドシートを「リンクを知っている全員が閲覧可」にするだけ（`/export?format=xlsx` で取得）。
- **6 種別対応**：原著論文・英文総説／著書・和文総説／発表・講演／受賞／アウトリーチ／広報。
- **著者の名寄せ**：名簿（Input confirmation シート）の和名↔ローマ字を正典に、
  決定的エイリアス照合＋`rapidfuzz` のあいまい一致で表記揺れ（`Hayashi N` / `Naoko Hayashi` / `林 直子` 等）を吸収。
- **年度フィルタ**：4 月始まりの年度で範囲指定。
- **日英切り替え**：サイドバー上部の「言語 / Language」でUI全体を日本語⇄英語に切替。
- **英日両方入力（データ）**：タイトル・雑誌名・学会名等は `_ja`/`_en` の2列で持ち、表示言語で自動選択（片方のみなら有る方）。旧・単一列DBも後方互換で表示可。
- **可変テンプレート**：プリセット（科研費 など）を選ぶだけ。細かい調整は各セクションの「書式を調整する」で、
  `{ }` で囲んだ項目の意味を日本語/英語で示しながら編集できる（プログラミング未経験でも分かるUI）。
- **太字・斜体**：項目を選ぶだけのメニューで指定。リッチ表示をドラッグコピーすると Word 等に書式ごと貼り付け可。
- **出力**：リッチ表示（書式保持コピー用）＋プレーンテキスト（折りたたみ）。**該当0件の種別・全0件の著者は自動で非表示**。

## データ入力（DB の形と入力経路）
DB は **Canonical 形式**（種別ごとに 1 タブ、1 行目＝安定したヘッダ名、1 行＝1 業績）。
各タブの先頭にメタ列 `record_id, status, submitter, source, created_at` を持ち、
アプリは **`status` が `確認済` の行のみ**読み込む（未確認は品質ゲートで除外）。
列を位置でなく**名前**で持つため、入力ミス・列ズレに強い。

入力経路は 2 つ:
- **Google フォーム（1 本）＋自動取込**（各メンバーが送信 → 回答が自動で DB の該当タブへ
  `status=未確認` で蓄積 → キュレーターが `確認済` に）。配布リンクは 1 本で、種別を選ぶと
  その種別の欄だけが出る。フォーム生成・自動取込は Apps Script `scripts/forms/publication_form.gs`。
  作成手順は [`docs/google-forms.md`](docs/google-forms.md) を参照。
- **一括取り込み**（多くの業績をまとめて登録・旧 DB 移行）。記入テンプレートを配って表で集め、
  `scripts/ingest_to_canonical.py` で一括追記する:
  ```powershell
  # 旧DB（崩れた形式）を丸ごと Canonical へ移行（status=確認済）
  .\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from legacy --out canonical.xlsx
  #   ローカル xlsx から: --src legacy.xlsx を追加
  # 一括入力テンプレート（種別ごとの Excel）を生成 → メンバーに記入してもらう
  .\.venv\Scripts\python.exe scripts\make_templates.py --all
  # 記入済みリスト（1種別）を既存 Canonical へ追記（status=未確認・重複除外）
  .\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from xlsx --type paper --src papers_filled.xlsx --append canonical.xlsx
  # 既存 DB を v2（英日2列 _ja/_en + note 列）へ一度だけ移行（英日入力・DOI補完・重複対応の前提）
  .\.venv\Scripts\python.exe scripts\ingest_to_canonical.py --from upgrade --src canonical.xlsx --out canonical_v2.xlsx
  ```
  テンプレートの見出しは論理フィールドへ確実に対応づく（手書きの表記ゆれも `rapidfuzz` で近似マッピング）。
  二ヶ国語の見出しは「○○（日本語）/（英語）」、言語マーカーの無い見出しは本文の言語で `_ja`/`_en` へ自動振り分け。

### 移行（旧DB → 新DB）の手順
1. 上記 `--from legacy` で `canonical.xlsx` を生成。
2. それを Google ドライブにアップロードし「Google スプレッドシートとして開く」（認証不要運用を維持）。
3. その共有 URL／ID をアプリのサイドバーに入力（既定で読みに行く DB を切り替える場合は
   `publication_summarizer/loader.py` の `DEFAULT_SHEET_ID` を新 ID へ更新）。
4. 旧シートは読み取り専用アーカイブとして凍結。

> 📘 はじめての人向けに、クリック箇所まで丁寧に説明した手順書があります → [`docs/migration-guide.md`](docs/migration-guide.md)

## セットアップ
```powershell
# 仮想環境の Python で依存をインストール
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

## 起動
```powershell
.\.venv\Scripts\python.exe -m streamlit run app.py
```
ブラウザが開いたら、サイドバーに対象シートの URL または ID を入力（既定値あり）。

## 動作検証
```powershell
# 既定: 同梱の合成フィクスチャでオフライン検証（ユニット＋統合）
.\.venv\Scripts\python.exe tests\verify.py
# ローカル xlsx を指定して検証
.\.venv\Scripts\python.exe tests\verify.py path\to\canonical.xlsx
# 共有 URL/ID を指定してライブ検証
.\.venv\Scripts\python.exe tests\verify.py <スプレッドシートURL または ID>
```

## デプロイ（Streamlit Community Cloud）
1. このリポジトリを GitHub に push。
2. share.streamlit.io でアプリを作成し、`app.py` を指定。
3. `requirements.txt` が自動でインストールされる。シートは閲覧可のままで OK。

## 限定公開（パスワード保護）
外部に広く見せたくない場合は、共有パスワードで保護できる。

- **ローカル**：`.streamlit/secrets.toml.example` を同じ場所に `secrets.toml` としてコピーし、
  `app_password = "..."` を設定（`secrets.toml` は Git にコミットされない）。
- **Streamlit Cloud**：アプリの **Settings → Secrets** に `app_password = "..."` を貼り付ける。
- パスワードを設定しなければ誰でも閲覧可（＝保護なし）。

さらに厳密にしたい場合は、Streamlit Cloud のアプリを **Private** にして、
**招待したメールアドレスのみ閲覧可**にする方法も併用できる（各閲覧者が Google 等でログイン）。

## 構成
```
app.py                          Streamlit UI（薄い）
publication_summarizer/
  schema.py                     シート→論理フィールド定義 & 種別定義（名前ベース）
  loader.py                     xlsx 取得 → ヘッダ名で共通スキーマへ正規化（status=確認済のみ）
  roster.py                     名簿パース & 著者名寄せ（決定的 + rapidfuzz）
  filters.py                    著者 / 年度 / 種別 / 査読の絞り込み
  formatter.py                  テンプレート整形（数値整形・著者強調・空欄圧縮）
  templates.yaml                書式プリセット（科研費ベース、編集可）
scripts/ingest_to_canonical.py  一括取り込み（旧DB移行 + 構造化リストの追記）
scripts/make_templates.py       一括入力テンプレート（種別ごとの Excel）を生成
scripts/ingest_paste.py         researchmap 等のプレーンテキストを解析して取り込み
scripts/forms/publication_form.gs  Apps Script: 1フォーム生成＋送信を Canonical へ自動取込（英日両入力・DOI補完・重複フラグ）
scripts/forms/canonical_tools.gs   Apps Script: キュレーター・メニュー（一括承認・DOI補完・重複再チェック）
tests/verify.py                 動作検証スクリプト（ユニット＋整合＋統合）
tests/test_form_fields.py       .gs の設問定義と schema の一致を検証（ドリフト防止）
tests/fixtures/                 検証用の合成 Canonical サンプル
docs/google-forms.md            Google フォーム（1本・自動取込）作成手順
```

## テンプレートのカスタマイズ
`publication_summarizer/templates.yaml` を編集してプリセットを追加できる。
プレースホルダ（`{authors} {title} {journal_abbr} {volume} {issue} {pages} {year} {doi}` 等）は
欠損時に空へ置換され、余分な区切り記号は自動圧縮される。利用可能なプレースホルダはファイル冒頭のコメント参照。

## スコープ外（将来）
- `.docx` / `.txt` / CSV ダウンロード、非公開シート（OAuth/サービスアカウント）、Colab ノートブック入口。
- LLM による著者名寄せ（`roster.resolve_with_llm()` フックのみ用意、未実装）。v1 は `rapidfuzz` で対応。
