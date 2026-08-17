# Working rules for this repo

This repo is PUBLIC. Two hard rules follow from that:

- **Never commit vendor-proprietary code or data** — Adobe camera
  profiles (.dcp, or tables parsed out of them), Nikon code, SDK
  payloads. Extracting such things locally for research is fine;
  committing them is copyright infringement. Keep them under gitignored
  paths (see `tools/camera-look/.gitignore`).
- **Never commit private machine/corpus details.** All machine-local
  paths, photo-corpus locations and shoot notes live in
  `PRIVATE_NOTES.md` at the repo root, which is gitignored by name —
  read it at the start of a session for local context, add to it rather
  than hardcoding. Scripts derive local paths from `Path.home()` or
  arguments, never from a literal home directory.

Also standing:

- Never modify input photo files. Test affordances that touch the
  corpus get proposed first, not built first.
- Measure before shipping: pipeline changes are validated against the
  camera-JPEG corpus (`tools/camera-look/`, numbers in its TODO.md).
