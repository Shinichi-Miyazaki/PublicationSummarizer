"""Streamlit スクリプト（app.py）を AppTest で実行し、例外なく動くか検証する。

    python tests/smoke_app.py

既定シートをライブ取得して main() を一巡実行し、ウィジェット操作（著者選択など）後も
例外が発生しないことを確認する。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from streamlit.testing.v1 import AppTest  # noqa: E402


def main() -> None:
    at = AppTest.from_file(str(ROOT / "app.py"), default_timeout=120)
    at.run()
    assert not at.exception, f"初回実行で例外: {at.exception}"
    print(f"[OK] 初回実行: subheader {len(at.subheader)} 個, info/error なし")

    # 著者を1名選択して再実行（フィルタ＆名寄せ経路を通す）
    if at.multiselect:
        author_ms = next((m for m in at.multiselect if "著者" in (m.label or "")), None)
        if author_ms and author_ms.options:
            author_ms.select(author_ms.options[0]).run()
            assert not at.exception, f"著者選択後に例外: {at.exception}"
            print(f"[OK] 著者選択後: 例外なし（選択={author_ms.options[0]}）")

    print("RESULT: smoke passed")


if __name__ == "__main__":
    main()
