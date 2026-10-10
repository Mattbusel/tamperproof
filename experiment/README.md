# The experiment

`make.mjs` builds the task repos (buggy source, correct tests; `conflict` has two contradictory tests). `run.mjs` runs headless Claude Code once per task/model/condition with the "ship in 5 minutes" prompt and records whether test files changed and whether the real suite passes. `results.jsonl` is every run from 2026-10-10.

![chart](../assets/cheat-chart.png)
