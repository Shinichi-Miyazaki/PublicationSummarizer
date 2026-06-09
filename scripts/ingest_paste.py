"""researchmap 等からコピーしたプレーンテキストを Canonical へ取り込む。

researchmap の業績一覧をプレーンテキストでコピーすると、1 件が概ね次の並びになる:

  論文 / 著書:
      タイトル
      著者（カンマ区切り）
      誌名・書名 [巻(号)] [ページ] YYYY年M月[D日]

  発表:
      演題
      （発表者：カンマ区切り。無い場合もある）
      学会・研究会名  YYYY年M月[D日]

本スクリプトは **末尾に日付（YYYY年M月[日]）を含む行を 1 件の区切り**とみなし、その上の行群を
タイトル／著者に割り当てて取り込む。種別ごとに構造が異なるため、貼り分けて --type を指定する。

使い方:
    # 論文をテキストファイルから取り込み（既存 Canonical へ追記・status=未確認・重複除外）
    python scripts/ingest_paste.py --type paper --src papers.txt --append canonical.xlsx
    # 発表を貼り付け（標準入力）→ 取り込み
    python scripts/ingest_paste.py --type presentation --append canonical.xlsx   # 貼り付け後 Ctrl+Z(Win)/Ctrl+D

取り込み後は status=未確認。シートで内容を確認し「確認済」にするとアプリに反映される。
タイトル・誌名・学会名などは本文の言語で _ja/_en へ自動振り分け（英日両対応）。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from ingest_to_canonical import CANONICAL_FIELDS, TAB_NAME, write_canonical  # noqa: E402
from llm_parse import DEFAULT_MODEL, LLMParseError, parse_records_llm  # noqa: E402

# 種別 → タイトル/会場相当フィールド（base 名）。二ヶ国語 base は後段で _ja/_en へ分割。
TITLE_FIELD = {"paper": "title", "book": "review_title", "presentation": "title",
               "award": "title", "outreach": "title", "publicity": "title"}
VENUE_FIELD = {"paper": "journal", "book": "book_title", "presentation": "conference",
               "award": "organization", "outreach": "venue", "publicity": "media_name"}

_VOLISSUE_RE = re.compile(r"(\d+)\s*\(\s*(\d+)\s*\)")
_PAGES_RE = re.compile(r"(\d+)\s*[-–—―]\s*(\d+)")

# 日付検出（researchmap は日本語/英語どちらの表記もありうる）。
_MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
           "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
_DATE_JP = re.compile(r"(\d{4})年\s*(\d{1,2})月(?:\s*(\d{1,2})日)?")
# 月名は完全な語のみ（\b で囲み、Marine 等の途中一致を防ぐ）。「Dec, 2021」「December 3, 2021」対応。
_DATE_EN = re.compile(
    r"\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|"
    r"Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\b"
    r"[.,]?\s*(?:(\d{1,2})\s*,?\s*)?(\d{4})",
    re.IGNORECASE)
_DATE_NUM = re.compile(r"(\d{4})[/\-.](\d{1,2})(?:[/\-.](\d{1,2}))?")


def _find_date(line: str):
    """行から日付を検出し (start, end, 'YYYY/M[/D]') を返す（無ければ None）。

    日本語「2025年7月[3日]」・英語「Dec, 2021 / December 3, 2021」・数値「2025/07/01」に対応。
    複数候補があれば最も前方のものを採用する。
    """
    cands = []
    m = _DATE_JP.search(line)
    if m:
        cands.append((m.start(), m.end(), int(m.group(1)), int(m.group(2)), m.group(3)))
    m = _DATE_EN.search(line)
    if m:
        cands.append((m.start(), m.end(), int(m.group(3)), _MONTHS[m.group(1).lower()[:3]], m.group(2)))
    m = _DATE_NUM.search(line)
    if m:
        cands.append((m.start(), m.end(), int(m.group(1)), int(m.group(2)), m.group(3)))
    if not cands:
        return None
    s, e, y, mo, d = min(cands, key=lambda c: c[0])
    return s, e, (f"{y}/{mo}/{int(d)}" if d else f"{y}/{mo}")


def _looks_like_authors(line: str) -> bool:
    """著者行らしいか（カンマ区切りの人名列）。"""
    return ("," in line) or ("，" in line) or ("、" in line)


def _parse_source(head: str, rtype: str, rec: dict) -> None:
    """日付より前の部分（誌名・巻号頁 等）を分解して rec に入れる。"""
    venue = head
    if rtype in ("paper", "book"):
        vi = _VOLISSUE_RE.search(venue)
        if vi:
            rec["volume"], rec["issue"] = vi.group(1), vi.group(2)
            venue = venue[:vi.start()] + " " + venue[vi.end():]
        pg = _PAGES_RE.search(venue)
        if pg:
            rec["pages"] = f"{pg.group(1)}-{pg.group(2)}"
            venue = venue[:pg.start()] + " " + venue[pg.end():]
    venue = re.sub(r"\s{2,}", " ", venue).strip(" ,，、")
    if venue:
        rec[VENUE_FIELD[rtype]] = venue


def parse_records(text: str, rtype: str) -> list[dict]:
    """プレーンテキストを種別 rtype のレコード（base フィールド）へ解析。"""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    records: list[dict] = []
    buf: list[str] = []

    for line in lines:
        found = _find_date(line)
        if not found:
            buf.append(line)
            continue

        # 区切り行（日付を含む）。日付より前を誌名・巻号頁として取り込む。
        start, _end, date_str = found
        rec: dict = {"date": date_str}
        _parse_source(line[:start], rtype, rec)

        # 直前までの行をタイトル／著者へ割り当てる。
        if buf:
            paper_like = rtype in ("paper", "book")
            if len(buf) >= 2 and (paper_like or _looks_like_authors(buf[-1])):
                rec["authors"] = buf[-1]
                title = " ".join(buf[:-1])
            else:
                title = " ".join(buf)
            rec[TITLE_FIELD[rtype]] = title.rstrip(" .。")

        if rec.get(TITLE_FIELD[rtype]) or rec.get("authors"):
            records.append(rec)
        buf = []

    return records


def main() -> None:
    ap = argparse.ArgumentParser(description="researchmap 等のプレーンテキスト → Canonical 取り込み")
    ap.add_argument("--type", dest="rtype", required=True, choices=list(CANONICAL_FIELDS),
                    help="取り込む業績種別（論文と発表は別々に貼り分けてください）")
    ap.add_argument("--src", help="貼り付けテキストのファイル。省略時は標準入力から読む。")
    ap.add_argument("--out", help="出力 Canonical xlsx（新規作成）")
    ap.add_argument("--append", help="既存 Canonical xlsx に追記（重複除外）")
    ap.add_argument("--llm", action="store_true",
                    help="GitHub Models(OpenAI互換) で構造化抽出する（要 GITHUB_TOKEN）。"
                         "失敗時は従来のヒューリスティック解析へ自動フォールバック。")
    ap.add_argument("--model", default=DEFAULT_MODEL,
                    help=f"LLM モデルID（既定: {DEFAULT_MODEL}）。--llm 指定時のみ有効。")
    args = ap.parse_args()

    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass

    append_to = Path(args.append) if args.append else None
    out = Path(args.out) if args.out else append_to
    if out is None:
        ap.error("--out か --append のいずれかが必要です。")

    if args.src:
        text = Path(args.src).read_text(encoding="utf-8")
    else:
        print("テキストを貼り付け、最後に EOF（Windows: Ctrl+Z→Enter / Mac・Linux: Ctrl+D）:")
        text = sys.stdin.read()

    if args.llm:
        try:
            recs = parse_records_llm(text, args.rtype, model=args.model)
            print(f"[LLM] {args.model} で {len(recs)} 件を構造化抽出しました。")
        except LLMParseError as exc:
            print(f"[警告] LLM 解析に失敗（{exc}）。従来のヒューリスティック解析にフォールバックします。")
            recs = parse_records(text, args.rtype)
    else:
        recs = parse_records(text, args.rtype)

    if not recs:
        print("[警告] 取り込める行が見つかりませんでした。各件の末尾に日付（YYYY年M月）があるか確認してください。")
        return

    by_type = {rt: [] for rt in CANONICAL_FIELDS}
    by_type[args.rtype] = recs
    added = write_canonical(out, by_type, source_label="paste", status="未確認", append_to=append_to)

    total = sum(added.values())
    print(f"\n[完了] {out} へ {total} 件を取り込みました（status=未確認）")
    for rtype, n in added.items():
        if n:
            print(f"  - {TAB_NAME[rtype]}: +{n}")
    print("内容を確認し、問題なければ status を「確認済」に（重複は note の dup_of が目印）。")


if __name__ == "__main__":
    main()
