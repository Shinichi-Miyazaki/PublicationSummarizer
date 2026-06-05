"""ドリフト防止テスト: Apps Script フォーム定義 と Canonical スキーマ の一致を検証。

scripts/forms/publication_form.gs の FIELD_MAP（種別 → tab/prefix/questions）を抽出し、
scripts/ingest_to_canonical.py の TAB_NAME / ID_PREFIX / CANONICAL_FIELDS と一致するか確認する。
schema 変更時にフォーム側の追随漏れ（列ズレ・タブ名違い・採番接頭辞違い）を検出する保険。

    python tests/test_form_fields.py     # 単体実行
（verify.py からは form_field_tests(check) として呼ばれる）
"""

from __future__ import annotations

import importlib.util
import json
import re
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT))

_GS_PATH = _ROOT / "scripts" / "forms" / "publication_form.gs"
_INGEST_PATH = _ROOT / "scripts" / "ingest_to_canonical.py"


def _load_ingest():
    """ingest_to_canonical.py を（パッケージ化されていなくても）モジュールとして読む。"""
    spec = importlib.util.spec_from_file_location("ingest_to_canonical", _INGEST_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_field_map() -> dict:
    """.gs から FIELD_MAP（strict JSON）を抽出して dict で返す。"""
    text = _GS_PATH.read_text(encoding="utf-8")
    m = re.search(r"// FIELD_MAP_JSON_BEGIN\s*var FIELD_MAP\s*=\s*(\{.*?\})\s*;\s*// FIELD_MAP_JSON_END",
                  text, re.DOTALL)
    if not m:
        raise ValueError("publication_form.gs から FIELD_MAP ブロックを抽出できませんでした。")
    return json.loads(m.group(1))


def form_field_tests(check) -> None:
    """verify.py の check(name, cond, detail) を使って一致を検証する。"""
    print("[form] Apps Script FIELD_MAP と Canonical スキーマの一致")
    ingest = _load_ingest()
    field_map = load_field_map()

    check("種別キーが一致", set(field_map) == set(ingest.CANONICAL_FIELDS),
          f"gs={sorted(field_map)} ingest={sorted(ingest.CANONICAL_FIELDS)}")

    for rtype, spec in field_map.items():
        check(f"[{rtype}] タブ名一致", spec["tab"] == ingest.TAB_NAME.get(rtype),
              f"gs={spec['tab']} ingest={ingest.TAB_NAME.get(rtype)}")
        check(f"[{rtype}] 接頭辞一致", spec["prefix"] == ingest.ID_PREFIX.get(rtype),
              f"gs={spec['prefix']} ingest={ingest.ID_PREFIX.get(rtype)}")
        gs_fields = [q["field"] for q in spec["questions"]]
        check(f"[{rtype}] フィールド並び一致", gs_fields == ingest.CANONICAL_FIELDS.get(rtype),
              f"gs={gs_fields} ingest={ingest.CANONICAL_FIELDS.get(rtype)}")


def template_header_tests(check) -> None:
    """一括入力テンプレートの見出しが ingest で正しい論理フィールドへ写ることを検証。"""
    print("[template] 一括入力テンプレートの見出し → 論理フィールド対応")
    ingest = _load_ingest()
    from scripts.make_templates import HEADER_LABELS  # noqa: PLC0415

    check("テンプレ種別が一致", set(HEADER_LABELS) == set(ingest.CANONICAL_FIELDS),
          f"tmpl={sorted(HEADER_LABELS)} ingest={sorted(ingest.CANONICAL_FIELDS)}")

    for rtype, labels in HEADER_LABELS.items():
        fields = ingest.CANONICAL_FIELDS[rtype]
        check(f"[{rtype}] 見出しが全フィールドを網羅", set(labels) == set(fields),
              f"tmpl={sorted(labels)} fields={sorted(fields)}")
        for field, label in labels.items():
            mapped = ingest._match_field(label, rtype)
            check(f"[{rtype}] 見出し『{label}』→ {field}", mapped == field,
                  f"got={mapped}")


def _main() -> None:
    failures = []

    def check(name, cond, detail=""):
        status = "OK" if cond else "FAIL"
        print(f"  [{status}] {name}" + ("" if cond else f"  {detail}"))
        if not cond:
            failures.append(name)

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    form_field_tests(check)
    template_header_tests(check)
    print(f"\nRESULT: {'OK' if not failures else str(len(failures)) + ' failed'}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    _main()
