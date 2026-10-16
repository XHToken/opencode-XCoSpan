---
name: xcospan-materials
description: Inspect and prepare local files for a task, preserving source references and selecting text, tables, or visual materials for analysis and reviewed cloud collaboration.
---

# Prepare local materials

Choose the files and representations needed for the user's goal. Reuse the host's available reading tools and domain Skills. Plain text and source code can be read directly; visual questions require inspecting the actual image or page. Spreadsheet calculations require a spreadsheet-capable tool that can inspect formulas, cell references, and calculated values.

## Extract document content

This Skill includes a local document extraction helper backed by Xberg. It detects formats from the file contents and filename. Query the installed engine's format registry when needed:

```sh
bun "<skill-directory>/extract.ts" --formats
bun "<skill-directory>/extract.ts" "<source-path>" > "<extraction-output>.json"
```

The result contains the resolved `source`, a `sha256` fingerprint of the bytes processed, and the engine's `results`: content, tables, pages or sheets, metadata, and processing warnings. Read the saved output using local tools. Select the relevant portions while preserving headings, clause numbers, sheet names, units, and source references.

The helper supports document, presentation, spreadsheet, PDF, text, markup, email, and archive formats exposed by the installed engine. It processes a local byte snapshot. Extraction errors terminate the command. Processing warnings remain in the result and must be considered when judging coverage.

## Select the appropriate representation

- **Documents and presentations:** use extracted structure for textual analysis. Inspect the rendered original when layout, embedded objects, annotations, or visual relationships affect the task.
- **Spreadsheets:** extracted tables show stored values. Formula cells may have empty or stale cached values. Use a spreadsheet-capable tool to recalculate the workbook and verify exact cell-level provenance.
- **Scans and image text:** explicitly select local OCR and the material's languages. OCR uses the engine's native Tesseract backend; the selected language data must be available locally. Repeat the option for multilingual material:

  ```sh
  bun "<skill-directory>/extract.ts" "<source-path>" --ocr-language eng --ocr-language chi_sim > "<extraction-output>.json"
  ```

- **Images and diagrams:** preserve the visual material when the task depends on it. OCR captures text; visual inspection establishes what the image shows. Use the available image redaction tool for image material selected for cloud collaboration. When the task requires a representation that the configured tools cannot prepare or review, report the missing capability before delegation.
- **Audio, video, or other specialized material:** use a local tool or Skill that supports the required transcription or analysis.

Keep the original file unchanged. Extraction output and metadata may contain private information. For cloud collaboration, select the necessary original text or images, complete each redaction review, then assemble the task for complete outbound approval. Source paths and extraction metadata stay local unless explicitly included in the reviewed task.
