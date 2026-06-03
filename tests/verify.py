"""動作検証スクリプト（pytest 非依存）。

    python tests/verify.py [path/to/workbook.xlsx]

引数で xlsx を渡すとオフライン検証。省略時は既定シートをライブ取得して検証する。
ユニット検証（純関数）＋統合検証（実データのロード・絞り込み・整形）を実行。
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from publication_summarizer import (  # noqa: E402
    AuthorMatcher,
    DEFAULT_SHEET_ID,
    RECORD_TYPES,
    by_authors,
    by_fiscal_year,
    load_publications,
    load_templates,
    parse_roster,
    render_records,
)
from publication_summarizer.formatter import clean_number, _cleanup  # noqa: E402
from publication_summarizer.loader import (  # noqa: E402
    _fiscal_year,
    _parse_date,
    load_roster_sheet,
    load_workbook_bytes,
)
from publication_summarizer.roster import Member  # noqa: E402

PASS, FAIL = 0, 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  [OK]   {name}")
    else:
        FAIL += 1
        print(f"  [FAIL] {name}  {detail}")


def unit_tests() -> None:
    print("[unit] clean_number")
    check("30.0 -> 30", clean_number("30.0") == "30")
    check("871.0 -> 871", clean_number(871.0) == "871")
    check("range kept", clean_number("1002-1010") == "1002-1010")
    check("empty", clean_number(None) == "")

    print("[unit] fiscal year")
    check("Apr -> same FY", _fiscal_year(_parse_date("2025/04/10")) == 2025)
    check("Jan -> prev FY", _fiscal_year(_parse_date("2026/01/16")) == 2025)
    check("slash short", _fiscal_year(_parse_date("2025/4/21")) == 2025)

    print("[unit] cleanup of empty fields")
    check("empty parens removed", "()" not in _cleanup("Title (). 2020"))
    check("dangling sep collapsed", _cleanup("a. b. 2020;():.") == "a. b. 2020")

    print("[unit] author matching (synthetic)")
    members = [
        Member(ja="林 直子", last="Hayashi", first="Naoko"),
        Member(ja="宮崎 慎一", last="Miyazaki", first="Shinichi"),
    ]
    m = AuthorMatcher(members, threshold=85)
    hayashi = members[0]
    check("full name", m.matches_member("Naoko Hayashi", hayashi))
    check("pubmed Lastname I", m.matches_member("Hayashi N", hayashi))
    check("with period", m.matches_member("Naoko Hayashi.", hayashi))
    check("japanese", m.matches_member("林 直子", hayashi))
    check("not other person", not m.matches_member("Taro Yamada", hayashi))
    check(
        "record has any",
        m.record_has_any("Okamura H, Yasugaki S, Hayashi Y", members),
    )


def integration_tests(source) -> None:
    print("[integration] loading workbook")
    df = load_publications(source)
    check("non-empty", not df.empty, f"rows={len(df)}")
    present = set(df["type"])
    check("papers present", "paper" in present)
    counts = df["type"].value_counts().to_dict()
    for rtype, label in RECORD_TYPES.items():
        print(f"    - {label}: {counts.get(rtype, 0)} 件")

    print("[integration] roster")
    roster = load_roster_sheet(source)
    members = parse_roster(roster)
    check("members parsed", len(members) > 5, f"n={len(members)}")
    names = {mm.last for mm in members}
    check("Miyazaki in roster", "Miyazaki" in names)

    print("[integration] author filter (Hayashi)")
    matcher = AuthorMatcher(members, threshold=85)
    hayashi = next((mm for mm in members if mm.last == "Hayashi" and mm.first == "Naoko"), None)
    if hayashi:
        sub = by_authors(df, [hayashi], matcher)
        check("Hayashi has records", len(sub) > 0, f"n={len(sub)}")

    print("[integration] fiscal year filter")
    fys = sorted({int(y) for y in df["fiscal_year"].dropna().unique()})
    if fys:
        sub = by_fiscal_year(df, fys[-1], fys[-1])
        check("latest FY subset <= all", len(sub) <= len(df) and len(sub) >= 0)

    print("[integration] formatting (科研費, papers)")
    templates = load_templates()
    papers = df[df["type"] == "paper"]
    spec = templates["paper"]["科研費"]
    out = render_records(papers, spec, emphasize=[m for m in members if m.last == "Miyazaki"], matcher=matcher)
    check("rendered non-empty", out["count"] > 0 and len(out["plain"]) > 0)
    check("no float .0 in volume", ".0;" not in out["plain"] and ".0)" not in out["plain"])
    check("self bold in markdown", "**" in out["markdown"] or out["count"] == 0)
    print("\n  --- sample (first paper, plain) ---")
    print("  " + (out["plain"].splitlines()[0] if out["plain"] else "(none)"))


def main() -> None:
    unit_tests()
    if len(sys.argv) > 1:
        source = Path(sys.argv[1]).read_bytes()
        print(f"\n[integration] using local fixture: {sys.argv[1]}")
    else:
        print(f"\n[integration] fetching live: {DEFAULT_SHEET_ID}")
        source = load_workbook_bytes(DEFAULT_SHEET_ID)
    integration_tests(source)

    print(f"\nRESULT: {PASS} passed, {FAIL} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
