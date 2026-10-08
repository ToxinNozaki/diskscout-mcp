# Changelog

## 0.2.0

Speed and eight new tools.

- Much faster scanning. New Windows engine based on robocopy list mode, run in parallel across folders, with a built in self test and automatic fallback. The standard engine was rewritten around a callback work queue and a larger thread pool.
- Scans now report their engine and files per second. `scan_folder` gained an `engine` option (`auto`, `node`, `robocopy`).
- New tools: `find_dev_artifacts`, `find_folders`, `find_duplicates`, `save_snapshot`, `compare_snapshot`, `recycle_bin_info`, `empty_recycle_bin`, `scan_status`.
- Each scan now keeps the 5000 largest files (was 2000).
- Tests for the new tools and a parser test for robocopy output.

## 0.1.0

First release.

- Tools: `list_drives`, `scan_folder`, `top_folders`, `top_files`, `cleanup_candidates`, `clear_cleanup_target`, `move_to_recycle_bin`
- Parallel scanner with progress reporting and in memory scan cache
- Protected path guard, dry run by default, JSON audit log
- Windows cleanup targets: temp, Windows Update cache, crash dumps, browser caches, npm, pip, Yarn, Bun, NuGet, Gradle, Cargo, Conda, Discord, VS Code, Adobe, Steam
