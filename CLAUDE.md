# PublicationSummarizer

## 決定事項

- [2026-08-21] 一括貼り付けの LLM 構造化を GitHub Models から OpenAI API 直接課金へ移行 — GitHub Models が 2026-07-30 に retirement 済みで復旧しないため
- [2026-08-21] 移行先に OpenAI 無料枠（complimentary tokens）を使わない — 残高必須かつ学習データ共有へのオプトインが条件で、実使用量では課金しても年 1〜5 ドルに収まるため
