---
name: invoice-processing
description: >-
  Process and reconcile invoices: extract fields, validate totals, match to
  purchase orders, and flag discrepancies. Use for accounts payable workflows.
---

# Invoice Processing

Workflow:

1. Download invoice PDFs from email/portal.
2. Extract fields (vendor, date, amount, tax) using pdf tools or OCR.
3. Validate totals (subtotal + tax = total).
4. Match against purchase orders; flag mismatches.
5. Export a CSV for import into accounting software.

Tips:

- Keep originals; write extracted data to `out/invoices.csv`.
- Use Python `pdfplumber` or `pypdf` for text extraction.
  EOF
