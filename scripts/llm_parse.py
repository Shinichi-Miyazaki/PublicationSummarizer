"""OpenAI API で貼り付けテキストを構造化フィールドへ抽出する（任意機能）。

`ingest_paste.py` のヒューリスティック `parse_records` の代替。LLM は **フリーテキストの
構造化** だけを担い、DOI は本文に明記がある時だけ拾う（**捏造させない**）。DOI/メタの確定は
CrossRef に委ねる方針のため、ここでは生成しない。

トークン未設定・`openai` 未導入・API/JSON エラー時は `LLMParseError` を投げ、呼び出し側
（`ingest_paste.py`）が従来解析へフォールバックする。返り値は `parse_records` と同形の
base フィールド dict のリストで、`write_canonical`（二ヶ国語分割・重複除外）がそのまま処理する。

基盤: OpenAI Chat Completions API。
    Base URL : https://api.openai.com/v1
    認証     : API キーを環境変数 OPENAI_API_KEY で渡す
    モデルID : 既定 gpt-4.1-mini

`--base-url` / `--model` は OpenAI 互換エンドポイントであれば差し替えられる（Gemini の
OpenAI 互換エンドポイントやローカル LLM へ移行する場合もこの 2 つの変更で足りる）。

注: 旧基盤の GitHub Models は 2026-07-30 に retirement 済みで、接続先としては使えない。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_to_canonical import _BASE_FIELDS  # noqa: E402

DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "gpt-4.1-mini"

# 1 リクエストに載せる最大の非空行数（1 応答の出力上限対策。超過分はチャンク分割）。
_MAX_LINES_PER_CHUNK = 40

# タイトル相当（いずれか埋まっていれば 1 件として採用）。
_TITLE_KEYS = ("title", "review_title", "book_title")


class LLMParseError(RuntimeError):
    """LLM 解析の失敗（トークン無・openai 未導入・API/JSON エラー）。呼び出し側でフォールバックする。"""


def get_token() -> str:
    """OpenAI API キーを環境変数 OPENAI_API_KEY から取得。"""
    return (os.environ.get("OPENAI_API_KEY") or "").strip()


def llm_enabled(token: str | None = None) -> bool:
    """LLM を使える状態か（トークンの有無）。"""
    return bool(token if token is not None else get_token())


def _chunks(text: str):
    """非空行を _MAX_LINES_PER_CHUNK 行ずつのチャンクに分けて返す。"""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    for i in range(0, len(lines), _MAX_LINES_PER_CHUNK):
        yield "\n".join(lines[i:i + _MAX_LINES_PER_CHUNK])


# 種別ごとの補足。スキーマ上の非自明な約束（キー名から意味を推測できないもの）を明示する。
# book は「著書」と「和文総説」を 1 種別で扱い journal キーを持たないため、誌名の行き先を必ず伝える。
_TYPE_NOTES: dict[str, str] = {
    "book": (
        "- この種別は「著書」と「和文総説」の両方を扱う。journal というキーは存在しない。\n"
        "- **和文総説（雑誌に載った総説）は、掲載誌名を book_title に入れる**"
        "（book_title は「書名または掲載誌名」の意味）。\n"
        "- review_title は章タイトルまたは総説タイトル。\n"
        "- chapter は章番号のみ（章タイトルは review_title に入れる）。\n"
        "- 書名に出版社が括弧書きで併記されていれば publisher へ分離する。\n"
    ),
}


def _field_list(rtype: str) -> str:
    """`field（日本語ラベル）` 形式のキー一覧。キー名だけでは意味が伝わらないため必ずラベルを添える。"""
    labels = _base_labels(rtype)
    return ", ".join(
        f"{f}（{labels[f]}）" if f in labels else f for f in _BASE_FIELDS[rtype]
    )


def _base_labels(rtype: str) -> dict[str, str]:
    """base フィールド → 日本語ラベル。出典は make_templates.BASE_LABELS（二重管理を避ける）。"""
    try:
        from make_templates import BASE_LABELS  # 遅延 import（openpyxl 依存を読み込み時に持ち込まない）
    except Exception:  # noqa: BLE001  # 取得できなければラベル無しのキー名だけで続行する
        return {}
    return BASE_LABELS.get(rtype, {})


def _build_prompt(rtype: str, chunk: str) -> str:
    return (
        "あなたは研究業績テキストの構造化抽出器です。貼り付けテキストから業績を 1 件ずつ抽出し、"
        '{"records": [ {...}, ... ]} という JSON だけを返してください。\n'
        f"各レコードのキーは次のみを使う（括弧内はその項目の意味）: {_field_list(rtype)}\n"
        "規則:\n"
        "- 本文に存在する情報だけを入れる。推測・創作はしない。\n"
        '- doi は本文に明記がある時だけ。無ければ "" （絶対に生成・推測しない）。\n'
        '- date は "YYYY/M" もしくは "YYYY/M/D"。\n'
        "- title・journal・conference 等は原文の言語のまま（翻訳しない）。\n"
        '- volume / issue は数字、pages は "開始-終了"。\n'
        '- 不明な項目は "" を入れる。\n'
        + _TYPE_NOTES.get(rtype, "")
        + "\nテキスト:\n" + chunk
    )


def _call(client, model: str, rtype: str, chunk: str) -> list:
    resp = client.chat.completions.create(
        model=model,
        temperature=0,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": "厳密な JSON のみを出力する構造化抽出器。"},
            {"role": "user", "content": _build_prompt(rtype, chunk)},
        ],
    )
    content = (resp.choices[0].message.content or "{}").strip()
    data = json.loads(content)
    recs = data.get("records", data) if isinstance(data, dict) else data
    if not isinstance(recs, list):
        raise LLMParseError("LLM 応答に records 配列が見つかりません")
    return recs


def _normalize_llm_records(raw: list, rtype: str) -> list[dict]:
    """許可キーのみ・文字列化・空件除外で base-dict のリストにする（parse_records と同形）。"""
    allowed = set(_BASE_FIELDS[rtype])
    out: list[dict] = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        rec = {}
        for key, val in r.items():
            if key in allowed and val not in (None, ""):
                s = str(val).strip()
                if s:
                    rec[key] = s
        if any(rec.get(k) for k in _TITLE_KEYS) or rec.get("authors"):
            out.append(rec)
    return out


def parse_records_llm(text: str, rtype: str, *, model: str = DEFAULT_MODEL,
                      base_url: str = DEFAULT_BASE_URL, token: str | None = None) -> list[dict]:
    """貼り付けテキストを LLM で構造化し、base フィールド dict のリストを返す。

    失敗時は LLMParseError を投げる（呼び出し側で従来解析へフォールバックする）。
    """
    # token を明示指定した場合は環境変数へフォールバックしない（"" を渡すテストが環境に依存しないため）。
    token = get_token() if token is None else token
    if not token:
        raise LLMParseError("OPENAI_API_KEY が未設定です")
    if rtype not in _BASE_FIELDS:
        raise LLMParseError(f"未知の業績種別: {rtype}")
    try:
        from openai import OpenAI  # 遅延 import（未導入でも基本機能は動作する）
    except ImportError as exc:
        raise LLMParseError("openai パッケージが必要です（pip install openai）") from exc

    try:
        client = OpenAI(base_url=base_url, api_key=token)
        raw: list = []
        for chunk in _chunks(text):
            raw.extend(_call(client, model, rtype, chunk))
    except LLMParseError:
        raise
    except Exception as exc:  # noqa: BLE001  # API/JSON/ネットワーク等は一括してフォールバック対象に
        raise LLMParseError(f"LLM 解析に失敗しました: {exc}") from exc

    return _normalize_llm_records(raw, rtype)
