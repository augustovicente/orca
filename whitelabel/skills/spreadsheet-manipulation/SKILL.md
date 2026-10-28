---
name: spreadsheet-manipulation
description: >-
  Manipulate CSV/XLSX spreadsheets for accounting: clean, transform, reconcile,
  and export. Use when working with downloaded accounting reports.
---

# Spreadsheet Manipulation

Prefer Python with pandas/openpyxl for transformations:

```bash
python3 -c "import pandas as pd; df=pd.read_csv('report.csv'); print(df.head())"
```

Guidelines:

- Preserve original files; write outputs to a separate `out/` folder.
- Validate totals and row counts after transforms.
- Use CSV as interchange format when possible.
- For Excel, use openpyxl to preserve formatting.
  EOF
  echo done
