---
name: git-commit
description: Use when creating git commits to ensure commit messages follow project standards. Applies the 7 rules for great commit messages with focus on conciseness and imperative mood.
---

# Git Commit Guidelines

Follow these rules when creating commits for this repository.

## The 7 Rules

1. **Separate subject from body with a blank line**
2. **Limit the subject line to 50 characters**
3. **Capitalize the subject line**
4. **Do not end the subject line with a period**
5. **Use the imperative mood** ("Add feature" not "Added feature")
6. **Wrap the body at 72 characters**
7. **Use the body to explain what and why vs. how**

## Key Principles

**Be concise, not verbose.** Every word should add value. Avoid unnecessary details about implementation mechanics - focus on what changed and why it matters.

**Subject line should stand alone** - don't require reading the body to understand the change. Body is optional and only needed for non-obvious context.

**Focus on the change, not how it was discovered** - never reference "review feedback", "PR comments", or "code review" in commit messages. Describe what the change does and why, not that someone asked for it.

**Avoid bullet points** - write prose, not lists. If you need bullets to explain a change, you're either committing too much at once or over-explaining implementation details.

## Format

Always use a HEREDOC to ensure proper formatting:

```bash
git commit -m "$(cat <<'EOF'
Subject line here

Optional body paragraph explaining what and why.
EOF
)"
```

## Good Examples

```
Add session isolation for concurrent executions
```

```
Fix encoding parameter handling in file operations

The encoding parameter wasn't properly passed through the validation
layer, causing base64 content to be treated as UTF-8.
```

## Bad Examples

```
Update files

Changes some things related to sessions and also fixes a bug.
```

Problem: Vague subject, doesn't explain what changed

```
Add file operations support

Implements FileClient with read/write methods and adds FileService
in the container with a validation layer. Includes comprehensive test
coverage for edge cases and supports both UTF-8 text and base64 binary
encodings. Uses proper error handling with custom error types from the
shared package for consistency across the SDK.
```

Problem: Over-explains implementation details, uses too many words

## Checklist Before Committing

- [ ] Subject is ≤50 characters
- [ ] Subject uses imperative mood
- [ ] Subject is capitalized, no period at end
- [ ] Body (if present) explains why, not how
- [ ] No references to review feedback or PR comments
- [ ] No bullet points in body
- [ ] Not committing sensitive files (.env, credentials)
