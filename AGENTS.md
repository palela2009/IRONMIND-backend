# Project instructions

- After making and verifying code updates, commit and push the task's changes to GitHub. The user authorized this as a standing preference on 2 November 2026; do not ask again for routine task-related pushes.
- This backend repository uses `main`. The Android app is in the sibling `IRONMIND` repository and uses `master`.
- Pushes trigger Render deployment. Verify that the live `/health` response reports the pushed Git revision before calling deployment complete.
- Preserve unrelated user changes, live account data, and balances. Test reward and purchase behavior against isolated test data.
- Do not commit secrets or generated output, or change vendored dependencies incidentally.
- Do not add ordinary explanatory comments to source code. Preserve required directives and license notices.
- Back up source changes outside the repository. Read and write source as UTF-8; avoid PowerShell `Get-Content` piped to `Set-Content` for edits.
