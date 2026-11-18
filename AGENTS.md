# Local development learnings

## Keep test runs bounded

- On this workstation, an unrestricted Pilot runtime test run coincided with a system freeze that required a hard reboot. Start with the smallest relevant tests and run one suite at a time, including across subagents.
- Before running a broad suite, inspect its runner and explicitly cap concurrency. For Node use `node --import jiti/register --test --test-concurrency=1 <files>`. For Rust use `cargo test --jobs 1 ... -- --test-threads=1` (the two flags cap build and test concurrency separately).
- Do not run the full Pilot runtime or mounted integration suite through the harness by default. Report the focused checks and ask before doing heavier verification; do not launch broad suites in parallel.
