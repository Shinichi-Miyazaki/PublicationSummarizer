"""GitHub Models（OpenAI 互換）で貼り付けテキストを構造化フィールドへ抽出する（任意機能）。

`ingest_paste.py` のヒューリスティック `parse_records` の代替。LLM は **フリーテキストの
構造化** だけを担い、DOI は本文に明記がある時だけ拾う（**捏造させない**）。DOI/メタの確定は
CrossRef に委ねる方針のため、ここでは生成しない。

トークン未設定・`openai` 未導入・API/JSON エラー時は `LLMParseError` を投げ、呼び出し側
（`ingest_paste.py`）が従来解析へフォールバックする。返り値は `parse_records` と同形の
base フィールド dict のリストで、`write_canonical`（二ヶ国語分割・重複除外）がそのまま処理する。

基盤: GitHub Models（無料枠・OpenAI Chat Completions 互換）。
    Base URL : https://models.github.ai/inference
    認証     : GitHub PAT（models:read 権限）を環境変数 GITHUB_TOKEN で渡す
    モデルID : openai/ 接頭辞（既定 openai/gpt-4.1-mini）
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_to_canonical import _BASE_FIELDS  # noqa: E402

DEFAULT_BASE_URL = "https://models.github.ai/inference"
DEFAULT_MODEL = "openai/gpt-4.1-mini"

# 1 リクエストに載せる最大の非空行数（無料枠の入力上限対策。超過分はチャンク分割）。
_MAX_LINES_PER_CHUNK = 40

# タイトル相当（いずれか埋まっていれば 1 件として採用）。
_TITLE_KEYS = ("title", "review_title", "book_title")


class LLMParseError(RuntimeError):
    """LLM 解析の失敗（トークン無・openai 未導入・API/JSON エラー）。呼び出し側でフォールバックする。"""


def get_token() -> str:
    """GitHub Models 用トークンを環境変数から取得（GITHUB_TOKEN 優先）。"""
    return (os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_MODELS_TOKEN") or "").strip()


def llm_enabled(token: str | None = None) -> bool:
    """LLM を使える状態か（トークンの有無）。"""
    return bool(token if token is not None else get_token())


def _chunks(text: str):
    """非空行を _MAX_LINES_PER_CHUNK 行ずつのチャンクに分けて返す。"""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    for i in range(0, len(lines), _MAX_LINES_PER_CHUNK):
        yield "\n".join(lines[i:i + _MAX_LINES_PER_CHUNK])


def _build_prompt(rtype: str, chunk: str) -> str:
    fields = list(_BASE_FIELDS[rtype])
    return (
        "あなたは研究業績テキストの構造化抽出器です。貼り付けテキストから業績を 1 件ずつ抽出し、"
        '{"records": [ {...}, ... ]} という JSON だけを返してください。\n'
        f"各レコードのキーは次のみを使う: {', '.join(fields)}\n"
        "規則:\n"
        "- 本文に存在する情報だけを入れる。推測・創作はしない。\n"
        '- doi は本文に明記がある時だけ。無ければ "" （絶対に生成・推測しない）。\n'
        '- date は "YYYY/M" もしくは "YYYY/M/D"。\n'
        "- title・journal・conference 等は原文の言語のまま（翻訳しない）。\n"
        '- volume / issue は数字、pages は "開始-終了"。\n'
        '- 不明な項目は "" を入れる。\n\n'
        "テキスト:\n" + chunk
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
    token = token or get_token()
    if not token:
        raise LLMParseError("GITHUB_TOKEN（または GITHUB_MODELS_TOKEN）が未設定です")
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
