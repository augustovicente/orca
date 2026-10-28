---
name: bank-reconciliation
description: >-
  Reconcile bank statements against accounting records: match transactions,
  identify unmatched items, and produce a reconciliation report.
---

# Bank Reconciliation

Steps:

1. Import bank statement CSV and ledger CSV.
2. Match by date + amount (+ reference).
3. List unmatched bank items and unmatched ledger items.
4. Investigate timing differences and missing entries.
5. Output reconciliation summary + unmatched lists to `out/recon-<date>.csv`.

Use fuzzy matching on descriptions when references are missing.
EOF
