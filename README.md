# 研究業績サマライザー

Google Spreadsheet（複数シートに分かれた研究業績）から、**著者・年度・業績種別**で絞り込み、
**提出先文書に応じた書式**（科研費がベース、提出先により編集可）で整形・プレビューする Streamlit Web アプリ。

## 特徴
- **認証不要**：スプレッドシートを「リンクを知っている全員が閲覧可」にするだけ（`/export?format=xlsx` で取得）。
- **6 種別対応**：原著論文・英文総説／著書・和文総説／発表・講演／受賞／アウトリーチ／広報。
- **著者の名寄せ**：名簿（Input confirmation シート）の和名↔ローマ字を正典に、
  決定的エイリアス照合＋`rapidfuzz` のあいまい一致で表記揺れ（`Hayashi N` / `Naoko Hayashi` / `林 直子` 等）を吸収。
- **年度フィルタ**：4 月始まりの年度で範囲指定。
- **可変テンプレート**：プリセット（科研費 など）を選ぶだけ。細かい調整は各セクションの「書式を調整する」で、
  `{ }` で囲んだ項目の意味を日本語で示しながら編集できる（プログラミング未経験でも分かるUI）。
- **出力**：コピー用プレーンテキスト（枠右上の 📋 でコピー）。**該当0件の種別・全0件の著者は自動で非表示**。

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
# ライブ取得で検証（ユニット＋統合）
.\.venv\Scripts\python.exe tests\verify.py
# 取得済み xlsx を使ってオフライン検証
.\.venv\Scripts\python.exe tests\verify.py path\to\workbook.xlsx
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
  schema.py                     シート→列インデックス位置マッピング & 種別定義
  loader.py                     xlsx 取得 → 共通スキーマ DataFrame へ正規化
  roster.py                     名簿パース & 著者名寄せ（決定的 + rapidfuzz）
  filters.py                    著者 / 年度 / 種別 / 査読の絞り込み
  formatter.py                  テンプレート整形（数値整形・著者強調・空欄圧縮）
  templates.yaml                書式プリセット（科研費ベース、編集可）
tests/verify.py                 動作検証スクリプト
```

## テンプレートのカスタマイズ
`publication_summarizer/templates.yaml` を編集してプリセットを追加できる。
プレースホルダ（`{authors} {title} {journal_abbr} {volume} {issue} {pages} {year} {doi}` 等）は
欠損時に空へ置換され、余分な区切り記号は自動圧縮される。利用可能なプレースホルダはファイル冒頭のコメント参照。

## スコープ外（将来）
- `.docx` / `.txt` / CSV ダウンロード、非公開シート（OAuth/サービスアカウント）、Colab ノートブック入口。
- LLM による著者名寄せ（`roster.resolve_with_llm()` フックのみ用意、未実装）。v1 は `rapidfuzz` で対応。
