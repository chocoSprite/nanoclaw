# Legacy Skill Path

This folder is kept for backward compatibility.

Canonical skills now live in `.agents/skills/`.
Migrated skills here are thin wrappers that delegate to `.agents/skills/`.
Unmigrated skills remain as upstream originals — migrate them when needed.

When updating skills, edit `.agents/skills/*` only.
