# Data Helper

Open `index.html` in a current desktop browser. No installation, server or internet connection is needed. Keep `index.html`, `styles.css`, `app.js`, `data.js`, `calculator.js`, `calculator-ui.js` and `vendor/` together when moving or hosting the app.

## Temperature differences

On desktop the page is a fixed, full-height workbench: the window itself never
scrolls. The left column holds everything you put in or configure (**1 Readings**);
the right column is reserved for output (**2 Results**). Each column scrolls
internally if its own content is taller than the window. Below 1040 px wide the
columns stack and the page becomes an ordinary scrolling document. Action icons
have hover titles and accessible names: upload, copy, download, example and clear.

The main flow is **1 Readings → 2 Results**. Paste cells or use the file picker in the same input column. **Copy for Excel** (top right of the results card) copies the entire result table; the download icon beside it saves it as .xlsx. Setup lives under the paste box: expand **Sensor pairs** to change the pair arrangement or signed/absolute mode, and **Detected columns** to correct a headerless paste. Missing date/time settings appear only when needed. After importing a file, source browsing and header controls appear below the results under **View source data & import settings**.

Copy the temperature table from Excel **with or without column headers**, then paste into the large text box. Both single headers and the example's two header rows are supported. Date & Time and Hours are carried over when present. Results update automatically.

The differential table, clipboard copy and Excel download always begin with **Date & Time** and **Hours(1/2 Hrs)**, as in the original sheet (an explicitly named source Hours column keeps its units). Supplied dates and Hours values stay aligned with their original readings, including any blanks. If the date column is omitted, enter the first reading date/time and interval to generate a regular schedule; until then dates stay blank. If Hours is omitted, it is generated in half-hour units starting at 1, with an editable starting value. The default 30-minute interval produces 1, 2, 3…; a 60-minute interval produces 1, 3, 5…. Set the interval to match your readings, or paste the original Hours column to preserve irregular intervals.

Without headers, the app detects leading date/time and hour-counter columns and assigns the remaining columns Temp-1, Temp-2, etc., from left to right. Ten temperature columns default to the example's arrangement with Temp-10 as ambient. The inferred mapping is shown above the results, with a **Pasted columns** override and an ambient checkbox. Numeric columns can be ambiguous (for example, an increasing temperature can look like an hours counter), so use the override if needed. Headerless selections are assumed to start at Temp-1; retain headers when copying other sensor numbers or a different sensor order.

The default arrangement matches the supplied workbook: T2−T1, T2−T3, T5−T4, T5−T6, T8−T7 and T8−T9. The adjacent preset uses T2−T1, T4−T3 and so on. Columns labeled Ambient are excluded from automatic pairing. Add, remove or edit pairs to match the installation; choose signed or absolute differences explicitly.

Results use 2 decimal places. Missing, error or nonnumeric readings produce blank results, with affected rows noted. Temperature input accepts decimal points and scientific notation. Optional temperature column headers can use names such as Temp-1, Temp 1 or Temperature 1. Paste at most the first 21 columns (A–U); later columns are ignored.

Clipboard text may contain Excel's rounded display values. Increase visible decimal places before copying, or import the file to calculate from its full stored precision. Recognized Max, Min, Average, Mean and Total summary rows are excluded from the readings.

**Copy for Excel** copies every result row, including headers. When the browser disallows automatic clipboard access, a selected text box allows ordinary Ctrl+C. **Download Excel** saves the complete differential table. Date/time text from the clipboard is preserved as text. The sample button supplies clearly labeled illustrative data.

Keep `calculator.js` and `calculator-ui.js` with the other app files. Importing a workbook also feeds its temperature readings into the calculator.

## Workbook browsing

- Drag and drop an `.xlsx` or `.xls` workbook, or use **Choose a file** (maximum 30 MB).
- Select a worksheet. The supplied temperature workbook is recognized with headers on rows 7–8 and readings from row 9. For other layouts, adjust **First header row** and **Header rows**, then **Apply layout**.
- Only A–U are retained in the working dataset, searched and exported. U is retained even when blank. V and later columns are discarded after parsing.
- Search all columns, filter one column by text, and click a heading to sort. The first column shows the original Excel row number.
- **Export rows** downloads an Excel file containing every matching row in the current sort order, not just the current page. It contains values and number formats with flattened headers, not the original workbook's charts, merged layout or formulas.
- Formulas use cached results from the last Excel save; the app does not recalculate them. Save in Excel before importing if results are missing or outdated.
- All file processing happens in browser memory. The app has no backend, analytics, external requests or persistent storage. Removing a file or reloading clears the workspace.

## Dependency

SheetJS Community Edition 0.20.3 is included locally in `vendor/`, under Apache 2.0. Source and browser integration instructions: https://docs.sheetjs.com/docs/getting-started/installation/standalone/

## Verification

Run `node tests/verify.cjs "C:\path\to\Example of Data Sheet.xlsx"` to check the actual example import, column exclusion, filters, sorting and export round trip.
